# Live scanner UX todo list

Five requested enhancements to the live deck-tracking scanner
([DeckCardScanner.jsx](../../frontend/src/components/DeckCardScanner.jsx)),
grounded in its current behavior. Todo list only — no implementation yet.
Items 1-2 extend the existing per-card feedback; items 3-4 are bigger and
probably deserve their own design pass before starting.

---

## 1. Floating match thumbnail + confidence percentage

**Status: partially done.** [Phase 3](live-card-scanner.md) shipped
(`b40474e`, `8041f31`, `c9d7e6c`) and delivers the confidence-percentage
half of this — a live badge (number + confidence, with a name preview once
it uniquely resolves) shown *while framing the card*, before capture. What
Phase 3 does **not** do is the other half of this item: freezing a card
thumbnail + percentage together at the moment of auto-save, the way the
green checkmark does today. Still open if that combined post-save view is
still wanted now that the pre-capture badge exists — it may cover the same
need well enough on its own.

**Current state:** on a confident auto-save, the scanner shows only a plain
green checkmark for `CHECKMARK_DURATION_MS` (900ms) — no card image, no
score. A warning (not-in-deck / already-complete) shows the card's *name*
as text, still no image. No numeric confidence is surfaced anywhere today;
`_identity_confident` from `recognizeCard`/`matchDeckImage` is a boolean.

**Decided:** reuse the OCR-confidence percentage from
[Phase 3](live-card-scanner.md), not a new match-confidence score. That
means this item is **gated on Phase 3 landing** — today's `DeckCardScanner`
only runs OCR once, synchronously, inside `captureAndRecognize` (via
`tryOcrMatch`/`runOcr`), and never keeps a live percentage around; Phase 3
is what introduces the continuous throttled OCR readout that actually
produces a number to show. Until Phase 3 ships there's no percentage to
float.

**Todo:**
- Replace (or augment) the checkmark overlay with the matched card's
  thumbnail (`resolveCardImageUrl(candidate, 'small')`, already used in the
  ambiguous-match list) alongside Phase 3's confidence percentage, shown
  together once a card auto-saves.
- Phase 3's percentage is a *pre-capture, still-framing* readout (per its
  "at a glance" — updates every ~500-800ms while positioning the card).
  Decide what value freezes into the floating badge at the moment of
  auto-save: the last live reading before capture, or a fresh OCR pass on
  the final captured crop. They can differ if the number changed in the
  time between the last live tick and the actual capture.

## 2. Recent-scans stack (last 3-5, sliding/expiring)

**Status: done.** Shipped on `scanner-recent-scans-stack`. Bottom-right
anchored stack (RECENT_SCANS_LIMIT=3, tuned down from an initial 5 after
ui-review found 5 stacked 120px thumbnails taller than the video container
itself), newest enters at the bottom and pushes earlier ones up, oldest
collapses out at the cap. Persists across the scanner closing/reopening
(explicitly does *not* reset on `isOpen`, per real-device feedback).

**Current state:** nothing persists across cards — `result`/`checkmarkMeta`
are cleared by `resetForNextCard`/`enterSuccessCooldown` before the next
hunt starts. No history of what was just scanned.

**Todo:**
- New state (array, max 3-5) of `{ image, name, cardId, scannedAt }` for
  recently-confirmed cards, appended in `confirmCard`/`enterSuccessCooldown`.
  Lives in `DeckCardScanner` (reset on close/`isOpen` like the rest of its
  state) unless item 3 needs it lifted to `DeckDetail.jsx`.
- Stack UI: newest card enters at the bottom, existing thumbnails shift up,
  oldest (top) fades/slides out past the 3-5 cap. No animation library is
  currently in `frontend/package.json` (checked — no framer-motion/
  react-spring); a CSS transition on a small fixed-size stack is enough,
  no new dependency needed.
- Placement: screen space is tight on phones (video already fills most of
  the viewport, per the existing `bottom-3`-anchored "Scan now" button
  comment) — needs a concrete layout spot, not just "add it somewhere."

## 3. Quick multi-add of the last (or one of the last 3-5) scanned card

**Status: done, but via a different design than either option below.**
Rather than a `quantity > 1` backend call or an N/+3/+4 stepper UI, each
recent-scans thumbnail (item 2) is itself a tap target: tapping it re-runs
the existing single-copy `confirmCard` save path for that same card.
Trades a slightly slower N-taps-for-N-copies interaction for reusing the
exact same save/warning/error plumbing every other confirm already has,
rather than a second path to keep in sync — and sidesteps the `quantity`
plumbing question below entirely, since it's never used.

**Use case:** energy cards and other duplicates, to avoid re-scanning each
physical copy.

**Current state:** `register_scan` in
[deck_progress.py](../../backend/services/deck_progress.py) already accepts
a `quantity` parameter — but `DeckDetail.jsx`'s `scanMutation` hardcodes
`quantity: 1` when calling `addToCollection`. So a "+3" quick-add can be a
single call with `quantity: N` for the same `card_id`, not N sequential
scan calls — worth confirming `addToCollection`'s backend route
(`backend/api/collection.py`) accepts and forwards `quantity` the same way
before assuming this is a pure frontend change.
- Also check `SCAN_ALREADY_COMPLETE` capping behavior in `register_scan` —
  quick-adding N copies past the deck's expected quantity needs to hit the
  same cap/warning path a single over-scan does today, not bypass it.

**Todo:**
- A "+N" control near the floating thumbnail (item 1) for the just-scanned
  card, and/or a tap target on each item 2 stack entry, both driving one
  `scanMutation`-style call with `quantity` > 1.
- Decide the increment UI (stepper? preset +1/+3/+4 buttons for common
  playset sizes?) — needs a decision, not just a spec.

## 4. Multi-card simultaneous scanning (cards laid out on a table)

**Current state:** detection is single-card. `detectCardQuad` in
[cardDetection.js](../../frontend/src/utils/cardDetection.js) (jscanify/
OpenCV.js contour detection) returns one quad per frame, and the whole
tick-loop/stability-tracker/capture pipeline in `DeckCardScanner.jsx` is
built around exactly one card in flight at a time (`pendingCaptureQuadRef`,
`awaitingCardRemovalRef`, etc. are all singular).

**Decided:** live multi-quad *detection* (see 3-4 cards laid out at once,
not one at a time), but recognition/capture still happens **one card at a
time**, sequentially — no requirement to identify all cards from a single
API call. This keeps the existing single-card `captureAndRecognize` →
`confirmCard` pipeline reusable almost as-is; the new work is upstream of
it (finding N quads instead of 1) and around it (a queue that feeds each
found quad through that same pipeline in turn), not a rewrite of
recognition itself. Meaningfully smaller than the "one paid call for
everything" version would have been.

**Todo:**
- `detectCardQuad` in
  [cardDetection.js](../../frontend/src/utils/cardDetection.js) currently
  returns the single largest contour. Needs a variant that returns up to
  3-4 non-overlapping quads per frame instead of one — a different contour
  problem than today's (filter/rank candidate contours rather than take
  the max), not a small tweak to the existing function.
- Capture trigger: the current "hold steady for `REQUIRED_STABLE_FRAMES`"
  model is built for one card entering/leaving frame
  (`awaitingCardRemovalRef` etc.) and doesn't map cleanly onto "several
  cards sitting still already." Likely wants an explicit "scan table"
  button (already have `handleScanNow`'s manual-trigger precedent) that,
  on tap, snapshots whichever quads are currently detected and queues them.
- Sequential processing: reuse `captureAndRecognize` per queued quad,
  fired one after another (not in parallel) — closer to a small state
  machine looping over a queue than new recognition logic. The per-card
  UI from items 1-2 (floating result thumbnail, recent-scans stack) should
  slot in naturally here since each queued card still goes through the
  same confirm path one at a time.
- Multi-quad crop/perspective-correct (`extractCard`) needs to run per
  detected quad, same as today, just called N times instead of once per
  capture.

## 5. Show which path resolved each scan (OCR name / OCR number / image match / paid API)

**Current state:** turns out the backend already computes and returns
exactly this, on both routes the scanner calls — it just isn't surfaced in
the UI. `match_deck_image` in
[decks.py](../../backend/api/decks.py) (the free, deck-scoped tier) sets
`_identity_decision` to `"deck_phash"` (image match), `"deck_number_unique"`
(OCR number match), or `"deck_name_unique"` (OCR name match). The paid
`recognize_card` route in
[recognize.py](../../backend/api/recognize.py) sets the same field to
`"number_unique"`/`"number_metadata"`/`"artist_hp"` (metadata match),
`"phash"` (broad-catalog image match), or `"gemini_visual"`/
`"{provider}_visual"` (the actual paid vision call). `DeckCardScanner.jsx`
receives this today in both `tryOcrMatch`'s `matchDeckImage` response and
`captureAndRecognize`'s `recognizeCard` response, and currently discards
it — only `_identity_confident`, `matches`, and `trace_id` are read.

**Todo:**
- Almost entirely a frontend surfacing task, not a new backend field —
  thread `data._identity_decision` through `captureAndRecognize` into
  whatever per-card result state items 1/2 already carry (it's available
  at the exact moment `confirmCard`/`enterSuccessCooldown` fire).
- Map the raw decision strings to a small set of user-facing labels (e.g.
  image match / OCR number / OCR name / metadata match / vision API) —
  the two routes use different raw strings for the same underlying idea
  (`"deck_phash"` vs `"phash"` are both "image match"), so this needs one
  shared mapping table, not per-route logic.
- Decide where it's shown — a per-card detail (e.g. on tap of a item-2
  stack thumbnail, or as a small tag alongside item 1's floating result)
  rather than cluttering the main capture UI, since this is closer to a
  diagnostic/trust signal than something needed on every scan.

---

## Suggested order

**2 and 3 are done.** Phase 3 shipped separately and covers the percentage
half of 1 — what's left of 1 is only the "freeze a thumbnail at the moment
of auto-save" half, and it's worth checking whether that's still wanted
before building it. Remaining, unstarted: **5** (path indicator — still
cheap, the backend data already exists, pure frontend plumbing, and pairs
naturally with item 2's stack as a tap target) and **4** (multi-card table
scanning — still the largest item; the multi-quad contour detection work
is new and worth prototyping/validating on a real table of cards before
committing to the capture-trigger and queueing design already sketched
above).
