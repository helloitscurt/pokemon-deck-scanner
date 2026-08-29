"""Shared image cache keyed by URL hash.

Used by card/set image serving (api/images.py) and pHash candidate downloads
(api/recognize.py) so the same underlying TCGdex image is only ever fetched
and cached once, regardless of which caller asked for it first.
"""

from __future__ import annotations

import hashlib

from sqlalchemy.orm import Session

from models import ImageCache


def image_cache_key(url: str) -> str:
    return f"img:{hashlib.sha1(url.encode('utf-8')).hexdigest()}"


def get_cached_image(db: Session, url: str) -> tuple[bytes, str] | None:
    cached = db.query(ImageCache).filter(ImageCache.image_key == image_cache_key(url)).first()
    if cached:
        return cached.data, cached.content_type
    return None


def store_cached_image(db: Session, url: str, data: bytes, content_type: str) -> tuple[bytes, str]:
    """Cache data under url's key; returns whichever bytes end up cached.

    On a concurrent write to the same key, the commit that lost the race
    returns the winner's already-committed row instead of raising.
    """
    entry = ImageCache(image_key=image_cache_key(url), data=data, content_type=content_type)
    db.add(entry)
    try:
        db.commit()
    except Exception:
        db.rollback()
        cached = get_cached_image(db, url)
        if cached:
            return cached
        raise
    return data, content_type
