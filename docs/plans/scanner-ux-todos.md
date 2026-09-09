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

**Decided:**
1. The tap target is the card image itself — the "+"/"-" stepper already
   sits beside it, not on top of it, so the image is free to be its own
   tap target again (unlike before the side-stepper redesign, when the
   image doubled as the quick-add button).
2. The captured crop's lifetime is tied 1:1 to that scan entry's own
   presence in the recent-scans stack — kept exactly as long as its
   thumbnail is visible there, discarded the moment that entry leaves
   `recentScans` (LRU eviction past `RECENT_SCANS_LIMIT`, or "-" removing
   it entirely), not on some separate timer. Note this is *not* quite
   "session-only": per item 1, the recent-scans stack itself deliberately
   persists across the scanner closing and reopening, so the captured
   image needs to live wherever the `recentScans` array entries themselves
   already live (state, not a short-lived ref that resets with the rest of
   the hunting-phase state) to actually survive that same close/reopen.

**Status: done.** See
[scanner-pause-speed-details.md](scanner-pause-speed-details.md) for the
full implementation plan/review. Each recent-scan thumbnail's image is a
tap target again (a small corner `Info` badge signals it, reusing the
`pathLabel` badge's own visual language, so it doesn't repeat the exact
discoverability problem that got the image demoted from a tap target the
first time around). Opens the existing `CardModal` (`CardItem.jsx`,
already used from `DeckDetail.jsx`) with `image` overridden to the real
captured photo when one exists — only `captureAndRecognize`'s confident
auto-save branch (covering both the continuous auto-trigger and a
confidently-resolved manual Scan Now tap) has a real full-card
`cropCanvas` in scope at confirm time; a manual ambiguous-list pick or
Path B's zoom-match auto-save fall back to catalog art. The captured
photo is stored directly on the `recentScans` entry (`scan.capturedImage`),
so it's discarded automatically whenever that entry itself leaves the
stack — no separate cleanup path.

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

## 10. Pause/stop the continuous scanning

**Current state:** as soon as the scanner opens (`phase === 'hunting'`),
Path A's 90ms detection/capture-trigger loop and Path B's 700ms number-OCR
loop both run continuously with no way to pause either — a card in frame
that happens to hold still long enough gets captured, whether or not the
user was actually still lining up the shot.

**Status: done.** See
[scanner-pause-speed-details.md](scanner-pause-speed-details.md) for the
full implementation plan/review. A gear icon in the scanner's header opens
a settings popup with a pause toggle: pausing suppresses only the
auto-capture trigger on both Path A (stable-hold) and Path B (zoom-match)
— detection and the overlay keep running live, so positioning feedback
never stops. `handleScanNow`'s existing manual button is deliberately not
gated by pause at all, matching the "line it up, then capture on demand"
use case. Momentary, not persisted — resets every time the scanner
reopens, so nobody who never touches the toggle sees any change in
behavior, and nobody ends up with a silently-forgotten-paused scanner
across an unrelated later session. The same settings popup also carries a
5-position slider for the detection outline's own tracking speed
(`OVERLAY_SMOOTHING_ALPHA` from item 9 above) — not originally scoped
under this item, but shipped alongside it since both needed the same new
settings surface.

## 11. Configurable collection-add behavior when re-scanning a deck to verify it

**Status: done.** Implemented as a persistent per-deck-instance toggle
(`DeckInstance.add_to_collection`, default `true`) — Option 1 below, decided
with the user over the "auto-add everything at deck creation" alternative
(Option 2), which would have incorrectly assumed every tracked deck is
already owned complete. The cross-deck lookup idea (last paragraph below) was
explicitly deferred to a separate task, not part of this change.

Backend: `POST /decks/instances/{id}/settings` persists the toggle;
`POST /decks/instances/{id}/scans/{card_id}/verify` and its `undo-verify`
counterpart move deck progress via the existing `register_scan`/
`unregister_scan` without ever touching `CollectionItem` — the same
"split the two effects" pattern the app already used in the undo direction
(`undo_scan` vs. `undo_scan_collection_only`, item 5), applied forward.
Frontend: a toggle in `DeckDetail.jsx`'s header card; `scanMutation`,
its inline auto-save Undo button, and `decrementMutation` all branch on the
deck's *current* `add_to_collection` value (a deliberate simplification —
this is a rarely-toggled persistent setting, not a per-scan flag).
`DeckCardScanner.jsx` itself needed no changes.

**Current state (before this change):** every confirmed scan adds to the collection
(`add_to_collection`, gated by `deck_scan_status` for whether it *also*
counts toward deck progress — see item 5 — but the collection add itself
always happens). There's no way to scan a deck purely to verify it's still
complete without each scan re-adding to the collection.

**Ask (from real usage):** scanning one already-built deck repeatedly to
confirm all 60 cards are still physically present shouldn't keep adding
duplicates to the collection after the first pass. Two ideas raised,
worth deciding between rather than assuming one:
1. A toggle for whether a scanning session adds to the collection at all —
   on for the first scan-through of a newly tracked deck, off for later
   "just verifying it's still all there" passes.
2. A different model entirely: once a deck is identified/added, auto-add
   *all* of its cards to the collection immediately at the deck's expected
   quantities. Each subsequent scan of a card in that deck then just
   *verifies* it's present (deck progress / a "confirmed still here" mark)
   rather than being a fresh collection add. This changes what a deck scan
   even represents — verification of existing inventory, not acquisition —
   and would need real rethinking of how `register_scan`/`add_to_collection`
   relate for deck-scoped scans specifically, not just a UI toggle.

Also worth designing regardless of which option above is chosen: if a
scanned card isn't part of the *currently open* deck's template
(`not_in_deck`), it could still belong to a *different* deck the user is
also tracking. Rather than silently falling into the generic
not_in_deck warning, consider matching against all of the user's tracked
deck templates and, on a match elsewhere, asking whether to add it to the
collection (and/or crediting the deck it actually belongs to) instead of
just the one currently open.

**Todo:**
- Design decision on the core model (per-session toggle vs.
  auto-add-at-deck-creation-then-verify) before implementing either.
- UI decision on where a collection-add toggle would live if option 1 is
  chosen: per-scan-session control in the scanner modal, a persistent
  per-deck-instance setting, or a global default in Settings.
- If pursuing the "check other tracked decks" idea: needs a lookup across
  all of the current user's deck instances' templates, not just the one
  `deckInstanceId` the scanner was opened against, plus a UI moment to ask
  the user rather than deciding silently either way.

## 12. Path B's zoom-match auto-trigger can double-capture a card Path A already saved

**Discovered while testing item 10's pause guard** (see a test's own debug
history in `scanner-pause-speed-details.md`) — real, pre-existing, and
independent of pause; pause just made it easy to reproduce by letting both
paths' streaks accumulate simultaneously before releasing them at once.

**Current state:** Path A's own auto-capture trigger checks
`capturedRegionsRef`/`isAwaitingRemoval` before firing, specifically to
avoid re-capturing a card its own region tracking already knows about (see
item 3's "does not re-capture" tests). Path B's `attemptZoomMatch`
auto-trigger has no equivalent check — its own condition is just
`activeJobsRef.current.length < MAX_CONCURRENT_JOBS` (`DeckCardScanner.jsx`).
If a physical card is held in frame long enough for BOTH paths' thresholds
to be satisfied (Path A's ~720ms stable-hold is normally much faster than
Path B's `REQUIRED_HIGH_CONFIDENCE_PASSES`-gated streak, so this is more
likely on a slow/uncertain OCR read, or exactly the pause scenario that
surfaced it), both can independently fire a confirmCard save for the same
card.

**Status: done.** Path B's own `quadInfo.quad` (from `latestQuadRef`) turned
out to already live in the exact same detection-frame coordinate space
`capturedRegionsRef`'s entries do — both come from the same Path A tick —
so Path B's trigger reuses Path A's own `quadsAreStable` check directly,
rather than a separate mechanism: before firing, it checks whether
`capturedRegionsRef` already has a region matching `quadInfo.quad`, and
skips (streak left intact, same as the existing paused/job-full cases) if
so. No quad at all — Path B's own main case, zoomed in past a card's
edges — has nothing to check against and is unaffected. A cross-path
regression test proves a card Path A already captured (and is still
holding a pending region for) can't also be captured by Path B's own
zoom-match while still held in frame; mutation-tested (removing the guard
turns the test red).

---

## Suggested order

**1, 2, 4, 5, 6, 7, 8, 9, 10, 11, and 12 are done.** Remaining: **3**
(multi-card table scanning — still the largest item; the multi-quad contour
detection work is new and worth prototyping/validating on a real table of
cards before committing to the capture-trigger and queueing design already
sketched above).
