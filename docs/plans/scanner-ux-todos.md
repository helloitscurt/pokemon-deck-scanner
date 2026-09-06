# Live scanner UX todo list

Requested enhancements to the live deck-tracking scanner
([DeckCardScanner.jsx](../../frontend/src/components/DeckCardScanner.jsx)),
grounded in its current behavior. See each item's own Status line — most
are now done; the Suggested order section tracks what's left.

---

## 1. Recent-scans stack (last 3-5, sliding/expiring)

**Status: done.** Shipped on `scanner-recent-scans-stack`. Bottom-right
anchored stack (`RECENT_SCANS_LIMIT=3`, tuned down from an initial 5 after
ui-review found 5 stacked 120px thumbnails taller than the video container
itself), newest enters at the bottom and pushes earlier ones up, oldest
collapses out at the cap. Persists across the scanner closing/reopening
(explicitly does *not* reset on `isOpen`, per real-device feedback).

## 2. Quick multi-add of the last (or one of the last 3-5) scanned card

**Status: done, but via a different design than either option originally
considered.** Rather than a `quantity > 1` backend call or an N/+3/+4
stepper UI, each recent-scans thumbnail (item 1) has its own "+" control:
tapping it re-runs the existing single-copy `confirmCard` save path for
that same card and folds the result into that thumbnail's own running
quantity count (`bumpRecentScanQuantity`) rather than adding a new
thumbnail. See item 5 below for the "-" side of this same control.

**Use case:** energy cards and other duplicates, to avoid re-scanning each
physical copy.

## 3. Multi-card simultaneous scanning (cards laid out on a table)

**Current state:** detection is single-card. `detectCardQuad` in
[cardDetection.js](../../frontend/src/utils/cardDetection.js) (jscanify/
OpenCV.js contour detection) returns one quad per frame, and the whole
tick-loop/stability-tracker/capture pipeline in `DeckCardScanner.jsx` is
built around finding at most one NEW quad per tick (`capturedRegionsRef`
now tracks several in-flight captures at once, as of the Phase 1
continuous-scan work, but detection itself still only ever proposes one
quad per tick).

**Decided:** live multi-quad *detection* (see 3-4 cards laid out at once,
not one at a time), but recognition/capture still happens **one card at a
time**, sequentially — no requirement to identify all cards from a single
API call. This keeps the existing single-card `captureAndRecognize` →
`confirmCard` pipeline reusable almost as-is; the new work is upstream of
it (finding N quads instead of 1) and around it (a queue that feeds each
found quad through that same pipeline in turn), not a rewrite of
recognition itself. Meaningfully smaller than the "one paid call for
everything" version would have been. Phase 1's `MAX_CONCURRENT_JOBS`
queueing (`submitCapture`/`drainQueue`) already gives this a place to feed
into once multi-quad detection exists.

**Todo:**
- `detectCardQuad` in
  [cardDetection.js](../../frontend/src/utils/cardDetection.js) currently
  returns the single largest contour. Needs a variant that returns up to
  3-4 non-overlapping quads per frame instead of one — a different contour
  problem than today's (filter/rank candidate contours rather than take
  the max), not a small tweak to the existing function.
- Capture trigger: the current "hold steady for `REQUIRED_STABLE_FRAMES`"
  model is built around one region entering/leaving frame at a time and
  doesn't map cleanly onto "several cards sitting still already." Likely
  wants an explicit "scan table" button (already have `handleScanNow`'s
  manual-trigger precedent) that, on tap, snapshots whichever quads are
  currently detected and queues them.
- Sequential processing: reuse `captureAndRecognize` per queued quad, fed
  through Phase 1's existing `submitCapture`/queue machinery rather than a
  new state machine — closer to "call it N times" than new recognition
  logic. The per-card UI from item 1 (recent-scans stack) should slot in
  naturally here since each queued card still goes through the same
  confirm path one at a time.
- Multi-quad crop/perspective-correct (`extractCard`) needs to run per
  detected quad, same as today, just called N times instead of once per
  capture.

## 4. Show which path resolved each scan (OCR name / OCR number / image match / paid API)

**Status: done.** Shipped (`34302bd`) — `decisionLabelKey` maps the
backend's raw `_identity_decision` values (`deck_phash`/`phash`,
`deck_number_unique`/`number_unique`, `deck_name_unique`,
`number_metadata`/`artist_hp`, `gemini_visual`/`{provider}_visual`) to a
small set of shared labels, shown as a quiet corner badge on each
recent-scans thumbnail (item 1). A quick-add bump never overwrites it —
the badge describes how the thumbnail's card was originally identified,
not every copy added since.

## 5. "-" should always be able to remove a scanned card, with confirmation

**Status: done.** Option 1 from the design discussion: a new backend route,
`POST /decks/instances/{id}/scans/{card_id}/undo-collection-only`
([decks.py](../../backend/api/decks.py)), reuses `undo_scan`'s own
deterministic `CollectionItem` lookup (extracted into a shared
`_decrement_or_delete_collection_item` helper) but skips
`unregister_scan` entirely — safe for `not_in_deck` (no deck-progress row
ever existed) and `already_complete` (that add never moved deck progress,
so there's nothing to wrongly decrement). `DeckCardScanner.jsx`'s "-" is
now always enabled (`removeDisabled` no longer checks `canRemove`); each
scan entry carries its `deckScanStatus` through to `onDecrement`, and
`DeckDetail.jsx`'s `decrementMutation` picks `undo_scan` for `'counted'`
or the collection-only route otherwise. A `useConfirmDialog` prompt
("Are you sure you want to remove this card from your deck?") gates the
call either way, matching this app's existing reset/delete confirm
pattern.

## 6. Trim the live view's debug/hint text to make room for a bigger camera + more recent-scan slots

**Status: done.** The `liveHintLowConfidence` variant and the entire
`debugInfo` readout block (`cam:`/`lib:`/`ocr ...` lines, plus the
now-unused `describeError` helper and `detectionStatus`/`lastOcrRawText`/
`lastOcrWords` imports) were removed outright — no opt-in diagnostics mode
was added in their place, per the decision to drop this entirely rather
than relocate it. `RECENT_SCANS_LIMIT` raised from 3 to 4 (498px of
stacked thumbnails, still under the video container's ~512px height at
its default aspect) now that the reclaimed space made a fourth slot worth
it.

## 7. Rework or remove the confusing live confidence-percentage badge

**Status: done.** Replaced the OCR-confidence reading with an actual
image-quality signal: a new [imageSharpness.js](../../frontend/src/utils/imageSharpness.js)
computes Laplacian-variance sharpness (a classic no-reference blur metric)
on the detected card region, read from the same detection-frame canvas
Path A already draws every tick. The OCR-confidence value that used to
drive the badge is kept, unexported, purely to gate the existing
auto-trigger streak (`NUMBER_CONFIDENCE_THRESHOLD`) — it's never displayed
again. The badge only shows a quality percentage when a card is actually
in frame; Path B's own number-text/name-preview reading still shows on
its own (no quality tint) when zoomed in past a card's edges, same as
before.

## 8. Tapping a recent-scan thumbnail should show card details + the scan image

**Current state:** each recent-scans thumbnail only has the "+"/"-"
stepper (items 2 and 5) — no way to see anything else about that scan.
`scan.image` (`resolveCardImageUrl(candidate, 'small')`) is the catalog
artwork, not the actual photo the camera captured; the real captured
crop/blob (`captureAndRecognize`'s `cropCanvas`/`blob`) is created,
uploaded, and discarded — nothing keeps it around after the request
completes.

**Todo:**
- Wire a tap-for-details affordance on each thumbnail (distinct from the
  "+"/"-" buttons, which already own the thumbnail's interactive surface —
  needs a UI decision on where a third tap target fits, e.g. tapping the
  image itself now that it's no longer also the quick-add button per the
  side-stepper redesign). Reuse this app's existing card-detail viewer
  (`CardModal`/`CompactCardArtwork`, already used from `DeckDetail.jsx` for
  browsing deck cards) rather than building a new one.
- "The image used to scan it" needs the actual captured crop kept around,
  not just re-derived from `scan.image` (the catalog artwork) — decide how
  long to hold onto it (this session only vs. persisted) and whether it's
  worth the memory/storage cost for what's essentially a diagnostic view.

## 9. Detection outline jumps around too much

**Status: done.** The drawn outline now lags toward each new raw quad via
simple exponential smoothing (`OVERLAY_SMOOTHING_ALPHA`, a reasoned
starting point — same real-device-tuning caveat as this file's other
detection constants) instead of snapping straight to it, resetting
instantly on an empty frame rather than smoothing out to nothing. Only the
drawn line changes — the stability tracker and capture trigger keep
reading the raw, unsmoothed quad, so the capture-trigger behavior itself
is unaffected.

---

## Suggested order

**1, 2, 4, 5, 6, 7, and 9 are done.** Remaining: **8** (tap-for-details —
needs a design decision on where a third tap target lives now that "+"/"-"
already own the thumbnail's interactive surface) and **3** (multi-card
table scanning — still the largest item; the multi-quad contour detection
work is new and worth prototyping/validating on a real table of cards
before committing to the capture-trigger and queueing design already
sketched above).
