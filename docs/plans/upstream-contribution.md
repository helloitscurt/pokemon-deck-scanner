# Contributing this fork back to upstream (Git-Romer/pokecollector)

**Status: deferred — not started.** This fork (`helloitscurt/pokemon-deck-scanner`)
has diverged from `upstream/main` (Git-Romer/pokecollector) by **76 commits,
74 files, +13,157/−251** as of 2026-09-06 — the entire deck-tracking feature
plus the live continuous-scan card scanner. This doc holds the drafted PR
text and the open decisions, so the actual PR isn't re-derived from scratch
whenever this gets picked up.

## Todo: a code review pass aimed at PR success, not just correctness

Before opening the real PR, do a pass over the diff specifically through
the lens of "will an unfamiliar upstream maintainer approve this," which is
a different bar than "does it work" (already covered by the multi-persona/
scanner-vision reviews already run during development). Things that lens
would catch that ordinary review doesn't:
- Commit history readability for a reviewer who wasn't in the room — 76
  commits includes several "fix: review findings from X" commits that only
  make sense with this session's own context. Consider whether to squash
  per-feature (deck tracking as one commit, scanner as another, etc.) or
  leave the granular history, and whether commit messages read fine cold.
- Code-style/convention consistency against upstream's own pre-existing
  code (not just internal consistency within this fork's new code) —
  naming, error-handling patterns, comment density — since this fork's own
  conventions evolved somewhat over 76 commits and may not perfectly match
  what was there before this fork started.
- Anything that reads as scanner-tuning-in-progress rather than settled
  (the "reasoned starting point, not calibrated" comments scattered through
  `DeckCardScanner.jsx`) — decide whether to soften/resolve these before
  presenting to an external reviewer, or keep them as honest disclosure.
- Whether the two "review findings" fix-commit patterns (this fork's own
  workflow of committing, reviewing, then committing fixes) leave any
  now-dead follow-up references in comments/docs pointing at internal
  review tooling that won't mean anything to an outside reviewer.

## Open decisions before opening the real PR

- **Split into multiple PRs?** Deck tracking and the live scanner are
  reasonably separable (the scanner's recognition pipeline doesn't
  strictly require deck tracking to exist, though its primary UI entry
  point today is from `DeckDetail.jsx`). A single 76-commit PR is a lot to
  review at once — splitting (deck tracking first, scanner second) is
  probably friendlier to a maintainer who hasn't seen any of this before.
- **`docs/plans/*.md` design docs** (`live-card-scanner.md`,
  `scanner-continuous-scan.md`, `scanner-ux-todos.md`) — keep them in the
  PR for context, or drop them if upstream doesn't want design docs
  in-repo?
- **`.claude/skills/*.md`** (`multi-persona-review`, `scanner-vision-review`)
  — these are Claude Code review-tooling, not application code. Almost
  certainly should be dropped from an upstream PR unless the maintainer
  specifically wants them.
- **Vendored binary assets (~18.4MB)** in `frontend/public/`:
  `opencv/opencv.js` (10.26MB), `tesseract/eng.traineddata` (4.11MB),
  `tesseract/tesseract-core-simd-lstm.wasm.js` (3.95MB),
  `tesseract/worker.min.js` (111KB), `opencv/jscanify.js` (7.3KB). License
  files are included alongside each, but vendoring vs. loading from a CDN
  at runtime is a real repo-size/deploy tradeoff worth a second opinion
  from whoever owns this repo before merging as-is.
- **Backend test plan caveat:** a full `unittest discover` run turned up 5
  failures, all in `test_scanner_settings.py::ScannerConfigurationTests` —
  that file isn't touched by this diff, so it looks pre-existing/
  environment-dependent rather than caused by this work, but it's
  unconfirmed against a clean upstream checkout. Worth checking before
  claiming a clean test run in the real PR.

## Drafted PR text (ready to use when this is picked back up)

**Title:**
```
Add preconstructed-deck completion tracking and a live continuous-scan card scanner
```

**Body:**
```markdown
## Summary

Two features built on top of this fork, plus the supporting infrastructure they needed:

1. **Deck tracking** — search Bulbapedia for a preconstructed product (Battle Deck / Battle Academy), auto-resolve its card list against the catalogue (with manual correction for anything ambiguous), then track scanned/owned copies against it with a missing-cards checklist. Several decks can be tracked independently at once.
2. **Live card scanner** — a continuous, camera-based scanner (`DeckCardScanner.jsx`) that holds a live video feed, detects a card's outline client-side, and recognizes it through a tiered pipeline (OCR-first → deck-scoped image match → paid vision API as a last resort) so most scans never hit a paid API call. Confident matches auto-save with no per-card tap; ambiguous ones fall back to a tap-to-confirm picker; a recent-scans stack lets you undo or quick-add without re-scanning.

This is a genuinely large diff for one PR (76 commits) — I'm glad to split it (e.g. deck tracking first, scanner second) if that's easier to review; let me know and I'll re-cut it.

## Deck tracking

- Backend: new `backend/api/decks.py` (deck instance CRUD, scan registration/undo, progress tracking), `services/deck_progress.py`, `services/bulbapedia.py` (decklist scraping/parsing), new `Deck`/`DeckCard`/`DeckInstance`/`ScannedCard` models and schemas.
- Frontend: new `AddDeck.jsx` (search → review → save), `DeckDetail.jsx` (progress view, scan entry point, missing-cards checklist, undo), `Decks.jsx` (list view), `deckChecklist.js`/`deckReview.js` utils.
- One line added to the README under Features.

## Live card scanner

- Client-side card detection via a vendored OpenCV.js + jscanify (`frontend/public/opencv/`) — no server round-trip just to find the card's outline in frame.
- Client-side OCR via a vendored Tesseract.js (`frontend/public/tesseract/`) for the free, OCR-first recognition tier.
- `useCameraStream.js`, `cardDetection.js`, `cardOcr.js`, `quadStability.js` (stable-hold detection), `numberBand.js` (collector-number region cropping), `imageSharpness.js` (Laplacian-variance blur/focus reading for a live image-quality badge) — each kept as pure, independently unit-tested modules where the underlying logic doesn't need a real DOM/canvas.
- Backend: `services/phash.py` (perceptual-hash matching against a deck's own missing cards, the free "Phase 2" tier), `services/scan_trace.py` (best-effort diagnostics: which recognition path resolved each scan, correlatable to a later undo), a shared image cache between card-image serving and pHash matching (`services/image_cache.py`).
- Continuous, non-blocking capture: multiple cards can be mid-recognition at once (`MAX_CONCURRENT_JOBS`) without the camera pausing; a confirmed save just lands in a "recently scanned" stack instead of blocking the feed.
- Undo: a scanned card can be reversed via a route that decrements-or-deletes both the collection and deck-progress rows together, or a narrower collection-only route for the two cases that route can't safely handle (card not in this deck's template, or already at its expected quantity).

## Supporting infrastructure

- `.github/workflows/backend-tests.yml` — a CI workflow for the backend test suite (didn't exist before this fork).
- `frontend/nginx.conf` — proper cache-control headers, including a fix for `index.html` having none at all (unlike everything else).
- Design docs under `docs/plans/` (`live-card-scanner.md`, `scanner-continuous-scan.md`, `scanner-ux-todos.md`) tracking the scanner's phased rollout and real-device tuning history — kept for context, happy to drop from the PR if upstream doesn't want design docs in-repo.
- Two `.claude/skills/*.md` files (project-specific Claude Code review checklists used while building this) — not application code; easy to drop from this PR if you'd rather they not land upstream.

## Vendored assets — please look closely here

This PR adds ~18.4MB of vendored, unminified-adjacent third-party binaries directly into `frontend/public/`:
- `opencv/opencv.js` — 10.26MB
- `tesseract/eng.traineddata` — 4.11MB
- `tesseract/tesseract-core-simd-lstm.wasm.js` — 3.95MB
- `tesseract/worker.min.js` — 111KB
- `opencv/jscanify.js` — 7.3KB

License files are included alongside each (`LICENSE-jscanify.txt`, `VENDORED.md` notes, `*.LICENSE.txt`), but vendoring vs. loading from a CDN at runtime is a real tradeoff worth a second opinion from whoever owns this repo's size/deploy story — happy to switch to a CDN reference if preferred.

## Test plan

- Frontend: 376 vitest unit tests pass across the full suite (including 54 for `DeckCardScanner.jsx` and dedicated coverage for `cardOcr`, `quadStability`, `numberBand`, `imageSharpness`, `deckChecklist`, `deckReview`).
- Backend: 775 unittest tests across the suite; 5 fail (`test_scanner_settings.py::ScannerConfigurationTests`) — that file isn't touched by this diff, so this looks pre-existing/environment-dependent rather than caused by this PR, but worth confirming against a clean upstream checkout before merging.
- Real-device tuning constants throughout the scanner (detection interval, stability tolerance, confidence thresholds, outline-smoothing factor, image-quality thresholds) are reasoned starting points — each is called out in its own code comment as "not yet calibrated against a range of real devices," not a settled value.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## When this gets picked back up

1. Decide the open questions above (split? keep docs/skills? vendor vs CDN?).
2. Re-diff `upstream/main...origin/main` (or whatever the fork's main branch
   is by then) to regenerate the file list/stats above — they'll be stale
   after any further work lands.
3. Re-run the backend suite in full (`docker compose exec backend python -m
   unittest discover -s tests -p "test_*.py"`) to confirm the
   `test_scanner_settings.py` failures are still unrelated/pre-existing.
4. Open the PR against `Git-Romer/pokecollector:main` with
   `head=<this fork>:main` (or whatever branch the split work lands on).
