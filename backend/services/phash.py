"""Perceptual-hash (pHash) image matching.

Extracted from api/recognize.py so it can be shared by two matchers with
different candidate sources: the broad TCGdex-search matcher in
recognize.py (candidates come from a live catalogue search, capped to
PHASH_CANDIDATE_LIMIT to bound an unbounded search result) and the
deck-scoped matcher in api/decks.py (candidates are a tracked deck's own
still-missing cards — a small, already-known, already-bounded list, where
capping to 8 would silently ignore most of a freshly-started deck). See
"Free disambiguation already exists: pHash" in
docs/plans/live-card-scanner.md for the original design this came from.
"""

from __future__ import annotations

import asyncio
import io
import warnings
from functools import lru_cache
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from services.image_cache import get_cached_image, store_cached_image
from services.scan_trace import ScanTrace

PHASH_MAX_DISTANCE = 20
PHASH_MIN_MARGIN = 5
PHASH_CANDIDATE_LIMIT = 8
MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024
MAX_REFERENCE_IMAGE_PIXELS = 50_000_000
TRUSTED_REFERENCE_IMAGE_HOSTS = {"assets.tcgdex.net"}


async def download_candidate_images(
    client: httpx.AsyncClient,
    candidates: list[dict],
    existing: dict[str, bytes] | None = None,
    db: Session | None = None,
) -> dict[str, bytes]:
    """Download each candidate image at most once for pHash/Gemini reuse.

    When db is given, checks/populates the shared image cache
    (services/image_cache.py) before hitting TCGdex — the same cache
    api/images.py's card/set image serving uses, so a candidate whose
    thumbnail was already viewed elsewhere in the app isn't re-downloaded
    here. db is optional (defaults to no caching) so existing callers that
    don't have a session handy are unaffected.
    """
    downloaded = dict(existing or {})

    async def fetch(candidate: dict) -> tuple[str, bytes] | None:
        candidate_id = str(candidate.get("id") or "")
        image_url = candidate.get("image")
        if not candidate_id or not image_url or candidate_id in downloaded:
            return None
        parsed_url = urlparse(str(image_url))
        if (
            parsed_url.scheme != "https"
            or parsed_url.hostname not in TRUSTED_REFERENCE_IMAGE_HOSTS
        ):
            return None

        if db is not None:
            cached = get_cached_image(db, str(image_url))
            if cached is not None:
                return candidate_id, cached[0]

        try:
            async with client.stream("GET", image_url, timeout=5) as response:
                if response.status_code != 200:
                    return None
                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        if int(content_length) > MAX_REFERENCE_IMAGE_BYTES:
                            return None
                    except ValueError:
                        return None

                content_type = response.headers.get("content-type", "image/webp")
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > MAX_REFERENCE_IMAGE_BYTES:
                        return None
                    content.extend(chunk)
                if content:
                    data = bytes(content)
                    if db is not None:
                        store_cached_image(db, str(image_url), data, content_type)
                    return candidate_id, data
        except Exception:
            return None
        return None

    results = await asyncio.gather(*(fetch(candidate) for candidate in candidates))
    downloaded.update(result for result in results if result is not None)
    return downloaded


@lru_cache(maxsize=1)
def _phash_dct_matrix():
    """Build the unnormalised DCT-II matrix used by imagehash.phash."""
    import numpy as np

    size = 32
    positions = np.arange(size)
    frequencies = np.arange(size)[:, None]
    return 2 * np.cos(
        np.pi * frequencies * (2 * positions + 1) / (2 * size)
    )


def perceptual_hash(image_bytes: bytes | None) -> tuple[bool, ...] | None:
    """Return the same 64-bit pHash as imagehash without its SciPy dependency."""
    if not image_bytes:
        return None
    try:
        import numpy as np
        from PIL import Image

        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as image:
                width, height = image.size
                if (
                    width <= 0
                    or height <= 0
                    or width * height > MAX_REFERENCE_IMAGE_PIXELS
                ):
                    return None
                pixels = np.asarray(
                    image.convert("L").resize(
                        (32, 32),
                        Image.Resampling.LANCZOS,
                    ),
                    dtype=float,
                )
        transform = _phash_dct_matrix()
        low_frequencies = (transform @ pixels @ transform.T)[:8, :8]
        median = np.median(low_frequencies)
        return tuple(bool(value) for value in (low_frequencies > median).flat)
    except Exception:
        return None


def phash_best_match(
    candidates: list[dict],
    photo_bytes: bytes | None,
    candidate_images: dict[str, bytes],
    trace: ScanTrace | None = None,
    candidate_limit: int = PHASH_CANDIDATE_LIMIT,
) -> dict | None:
    """Return a clearly separated perceptual match, otherwise abstain.

    candidate_limit defaults to PHASH_CANDIDATE_LIMIT (bounding a broad
    catalogue-search result) — the deck-scoped matcher passes a caller-sized
    limit instead, since its candidates are already a small, bounded,
    already-known list (a deck's own still-missing cards), and capping that
    to 8 would silently exclude most of a freshly-started deck.
    """
    photo_hash = perceptual_hash(photo_bytes)
    if photo_hash is None:
        return None

    scored: list[tuple[int, dict]] = []
    for candidate in candidates[:candidate_limit]:
        image_bytes = candidate_images.get(str(candidate.get("id") or ""))
        if not image_bytes:
            continue
        candidate_hash = perceptual_hash(image_bytes)
        if candidate_hash is None:
            continue
        distance = sum(left != right for left, right in zip(photo_hash, candidate_hash))
        scored.append((distance, candidate))

    if len(scored) < 2:
        if trace:
            trace.record_phash(
                [
                    (distance, str(candidate.get("tcg_card_id") or ""))
                    for distance, candidate in scored
                ],
                accepted=None,
                reason="insufficient_images",
            )
        return None
    scored.sort(key=lambda pair: pair[0])
    best_distance, best_candidate = scored[0]
    runner_up_distance = scored[1][0]
    too_far = best_distance > PHASH_MAX_DISTANCE
    too_close = runner_up_distance - best_distance < PHASH_MIN_MARGIN
    accepted = None if too_far or too_close else best_candidate
    if trace:
        trace.record_phash(
            [
                (distance, str(candidate.get("tcg_card_id") or ""))
                for distance, candidate in scored
            ],
            accepted=(
                str(accepted.get("tcg_card_id") or "") if accepted else None
            ),
            reason=(
                "too_far" if too_far else "ambiguous_margin" if too_close else "accepted"
            ),
        )
    if accepted is None:
        return None
    return accepted
