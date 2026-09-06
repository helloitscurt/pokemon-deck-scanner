# Live scanner UX todo list

Requested enhancements to the live deck-tracking scanner
([DeckCardScanner.jsx](../../frontend/src/components/DeckCardScanner.jsx)),
grounded in its current behavior. Todo list only — no implementation yet.

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

**Current state:** each recent-scans thumbnail's "-" (`decrementRecentScan`,
`DeckCardScanner.jsx`) is gated on `scan.canRemove`, which is only `true`
when the most recent add's `deck_scan_status` was `'counted'`
(`DeckCardScanner.jsx`'s `confirmCard`). For `'not_in_deck'` or
`'already_complete'` — either the card isn't part of this deck's template,
or the deck already has its full expected quantity of it — `canRemove` is
`false` and "-" is disabled outright (dimmed icon, no tap). That gate
exists because the backend's `undo_scan` route
([decks.py](../../backend/api/decks.py)) can't safely reverse those two
cases: it either 404s (card isn't in the deck's template at all) or would
decrement an unrelated earlier scan of the same card that DID count
(`already_complete`'s `matching_item` lookup is deterministic by
card/variant/condition, not "the one this specific button represents").

**Ask:** let "-" remove the card regardless — a user who scanned by mistake
needs a way to undo it even when the safety gate above says it can't be
cleanly reversed via `undo_scan`.

**Todo:**
- Needs a design decision, not just "remove the `canRemove` check": for
  the `not_in_deck`/`already_complete` cases, `undo_scan` isn't the right
  primitive (see above) — this either needs a different backend call that
  decrements the matching `CollectionItem` row directly by this card's
  resolved id (bypassing the deck-progress reconciliation `undo_scan` also
  does), or `canRemove` needs to become "always true," with the risk of
  occasionally decrementing the wrong physical copy's count accepted and
  documented.
- Add a confirmation step before the removal actually fires — e.g. this
  app's existing `useConfirmDialog` context (already used in
  `DeckDetail.jsx` for reset/delete) — with copy along the lines of "Are
  you sure you want to remove this card from your deck?" A tap-triggered
  destructive action with no undo-of-the-undo deserves the same
  confirm-first treatment already used elsewhere in this app, not the
  bare, immediate tap the "+" side has.
- On confirm, the thumbnail should disappear from the recent-scans stack
  immediately (or its quantity should drop by one) — reusing the existing
  `scheduleRecentScanRemoval`/quantity-decrement paths already in
  `decrementRecentScan`.

## 6. Trim the live view's debug/hint text to make room for a bigger camera + more recent-scan slots

**Current state:** below the video, `DeckCardScanner.jsx` always renders a
`liveHint`/`liveHintLowConfidence` line, and beneath that an always-visible
monospace debug block (`cam:{cameraStatus} lib:{debugInfo.libState}
ticks:{debugInfo.tickCount}`, plus conditional `ocr name:`/`ocr raw:`/`ocr
words:` lines once OCR has run at least once). This debug readout was
added because there's no devtools access on a phone and the detection loop
previously failed silently — genuinely useful during Phase 1-3
development, but it eats real vertical space below the video on every
screen size.

**Ask:** drop the low-confidence hint text and the whole debug/OCR readout
block — none of it is meaningful to a user day-to-day — and use the
reclaimed height to make the video area itself bigger and/or raise
`RECENT_SCANS_LIMIT` above its current cap of 3.

**Todo:**
- Remove the `liveHintLowConfidence`/`liveHint` paragraph and the entire
  `debugInfo` readout block (`cam:...`/`lib:...`/`ocr ...` lines) from the
  hunting-phase view.
- Decide whether the debug readout disappears entirely or moves somewhere
  opt-in (a settings toggle, a diagnostics mode) — it was load-bearing for
  diagnosing real-device detection failures during development; removing
  it outright means a future detection bug has no on-device visibility
  again unless something replaces it.
- `RECENT_SCANS_LIMIT`'s current cap of 3 was sized specifically against
  the video's height at its old, smaller footprint (see the constant's own
  comment: 5 stacked 120px thumbnails were taller than the video
  container). Growing the video area and/or the stack limit are coupled —
  revisit both together, not the stack limit alone, or the same clipping
  problem the original tuning avoided comes back.

## 7. Rework or remove the confusing live confidence-percentage badge

**Current state:** the top-left badge (`liveNumberConfidence`, Phase 3's
Path B) shows a number-only OCR confidence score, refreshed every
`NUMBER_OCR_INTERVAL_MS` (700ms) while framing a card. It's Tesseract's OCR
confidence on the collector-number crop specifically — not a measure of
overall image sharpness/focus, framing, or how likely the card is to be
correctly identified. The code's own comments already acknowledge this gap
elsewhere ("quad stability and focus sharpness are different things the
quad alone can't see," `DeckCardScanner.jsx`) — this badge has the same
limitation: a number can OCR confidently even when the rest of the photo
is blurry, and can read low-confidence on a perfectly good photo if the
number itself is small, worn, or at an angle.

**Ask:** the badge is confusing, updates too fast to track, and doesn't
actually represent "is this a good picture of the card."

**Todo:**
- Needs a design decision on what (if anything) replaces it: a genuine
  image-quality signal (blur/sharpness detection on the captured frame)
  would need new detection work, not a relabeling of the existing OCR
  score.
- If kept in some form, consider slowing its update cadence and/or
  smoothing (e.g. only update on a sustained change) so it reads as a
  stable signal instead of flickering every ~700ms.
- Simplest option, if no replacement signal is worth building right now:
  remove it outright, same as item 6's debug text — it may be doing more
  to erode trust in the scanner than to help.

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

**Current state:** `drawOverlay` (`DeckCardScanner.jsx`) redraws the
detection outline from that tick's raw `detectCardQuad` result every
`DETECTION_INTERVAL_MS` (90ms), with no smoothing or interpolation between
ticks — each frame's quad is drawn as-is, however much it moved from the
last one. `STABILITY_TOLERANCE_PROPORTION` (0.07) governs whether a quad
counts as "stable enough to capture," but doesn't affect how the outline
itself is drawn while it's still jittering below that threshold.

**Todo:**
- Needs real-device tuning, same caveat as this file's other detection
  constants ("reasoned starting points, not empirically calibrated against
  real devices yet") — likely a smoothing pass (e.g. an exponential
  moving average or a small median filter over the last few ticks' corner
  positions) applied only to the drawn outline, not to the raw quad
  `stabilityTrackerRef`/capture logic reads, so the capture-trigger
  behavior itself doesn't change, just how steady the outline looks while
  it's happening.

---

## Suggested order

**1, 2, and 4 are done.** Remaining: **5** (relax/redesign the "-" safety
gate plus a confirmation step — self-contained, and the most concrete
correctness/trust fix here), **6** and **7** (both are almost entirely
subtractive — removing text/badges rather than building new UI — cheap
relative to their payoff), **9** (a tuning/smoothing pass, no new
UI/state), **8** (needs a design decision on where a third tap target
lives before implementation), and **3** (multi-card table scanning —
still the largest item; the multi-quad contour detection work is new and
worth prototyping/validating on a real table of cards before committing to
the capture-trigger and queueing design already sketched above).
