# Live continuous-stream card scanner (deck-tracking scanner)

This document covers three phases. **Phase 1** replaces the deck-tracking
scanner's point-and-shoot flow with a live camera stream that auto-detects,
auto-captures, and (when confident) auto-saves a card — the core ask, and a
complete, shippable feature on its own. **Phase 2** is an optional follow-up,
gated on Phase 1 being live: recognize the card's text client-side (OCR)
instead of always paying for a vision-API call, falling back to the paid
call only for cards OCR can't confidently resolve. Phase 2 should not block
or delay Phase 1. **Phase 3**, gated on Phase 2 being live, turns OCR from a
one-shot step (fires only after a full card has already been held steady)
into a continuous background readout with a live confidence percentage,
specifically so a user can react to a low reading by physically zooming in
on the collector number — a capability the Phase 1/2 pipeline doesn't
support today, since it requires the whole card's outline in frame to do
anything at all. **Phase 4** makes the tuning constants Phase 1 and Phase 3
otherwise hardcode (how long a card must hold steady, Phase 3's auto-trigger
confidence threshold) into user-configurable settings, since the right
values genuinely depend on the phone's own camera and CPU, not just taste.

## Scope (confirmed with user)

- Replaces **`DeckCardScanner.jsx`** only — the point-and-shoot scanner used
  from the deck-detail "Scan cards" button. The general Collection scanner
  (`UnifiedCardScanner.jsx`, batch upload → async job → review queue) is
  **out of scope** and unchanged; its model doesn't map onto "auto-capture
  and immediately save" anyway.
- When the vision API returns a confident match (`_identity_confident: true`,
  already computed server-side today), **auto-save immediately** — no tap
  required. Only fall back to the existing tap-to-confirm candidate list when
  the match is ambiguous.
- External contract stays the same: `DeckCardScanner` keeps its
  `{isOpen, onClose, onConfirm}` props, so `DeckDetail.jsx` needs **no
  changes**. This is a rewrite of the component's internals, not a new
  page or a data-model change. **This settles the props, not the render
  container** — see "Rendering container" under Phase 1 below, which the
  `ui-review` pass found this framing had left unaddressed.

---

# Phase 1: live capture, one paid API call per card

### At a glance

- **What:** Replace the point-and-shoot deck scanner with a live camera
  stream that auto-detects a card, auto-captures once it's held steady,
  and auto-saves it when the match is confident — no manual photo tap.
  Includes an undo toast so a single bad auto-save doesn't require
  resetting the whole deck's progress.
- **Why:** Today's scanner needs a manual "Take Photo" tap per card. This
  removes that friction while keeping cost bounded — exactly one paid
  vision-API call per physically-presented card, not per video frame.
- **Code changes:** New client-side card detection (`cardDetection.js`,
  OpenCV.js/jscanify) and a camera-stream hook; `DeckCardScanner.jsx`
  rewritten as a full-viewport portal with a new state machine (reusing
  the existing `confirmCard`/candidate-picker, not a new save path); a
  new undo endpoint plus a small backend matching-row helper; a shared
  image cache extracted for pHash to reuse.

## Why this shape

The backend's `/api/cards/recognize` endpoint calls a paid vision API
(Gemini or an OpenAI-compatible provider) per image — see
`backend/api/recognize.py:1135`. A naive "keep sending frames" continuous
scanner would spam that endpoint and run up real API cost on every frame.
So the design keeps the *detection* loop entirely client-side and free, and
fires the *existing* recognize call exactly once per physically-presented
card:

```
[live video] --(cheap, local, every ~150ms)--> [find a card-shaped outline]
                                                        |
                                            stable for N frames?
                                                        |
                                              (freeze + crop the card)
                                                        |
                                   ONE call to the existing recognizeCard()
                                                        |
                                confident? --------------------- ambiguous?
                                    |                                |
                          auto-save, checkmark              existing candidate
                          + undo toast (~5s)                  picker (unchanged)
                          resume hunting after
                          a cooldown
```

The vision-call, save, and confident/ambiguous decision paths need **no
changes** for Phase 1 — verified:
- `recognizeCard(file)` (`frontend/src/api/client.js:113`) already accepts
  any `File`/`Blob` via `FormData` — a `canvas.toBlob('image/jpeg')` output
  drops straight in.
- The backend already accepts JPEG/PNG/WEBP up to 15MB
  (`backend/services/scan_storage.py:30-36`) — a cropped card photo is
  nowhere close to that.
- `_identity_confident` (`backend/api/recognize.py:1049`) already exists and
  is exactly the signal needed to decide auto-save vs. manual pick.
- **Checked: an "ambiguous" metadata result already gets a free
  image-comparison attempt before ever reaching a paid call or the manual
  picker** — see "Free disambiguation already exists: pHash" below. Nothing
  to build here either.

The one real backend change Phase 1 picks up is a small, independent cache
refactor (see the pHash section below) — it improves pHash's speed and
cuts redundant TCGdex fetches, but it isn't required for auto-detect/
auto-save to work and can land on its own schedule.

## Detection library: jscanify + OpenCV.js

Verified via the GitHub API before recommending it: **jscanify**
(`github.com/puffinsoft/jscanify`, MIT license, 1.7k stars, pushed
2026-07-20 — actively maintained, not abandoned). It's a small wrapper
around OpenCV.js built for exactly this use case — "find the largest
rectangular thing on a contrasting background, in a live video, and either
outline it or extract a perspective-corrected crop of it." That's a receipt
scanner, but a TCG card is the same shape of problem (fixed-aspect-ratio
rectangle on a table).

Two methods cover the whole feature:
- `scanner.highlightPaper(canvasOrVideoFrame)` — returns a canvas with the
  detected quadrilateral drawn on it. This **is** the "picks it up and
  outlines it" UI, almost for free.
- `scanner.extractPaper(video, width, height)` — perspective-corrected,
  cropped canvas of just the card. Convert to a blob and hand it to the
  existing `recognizeCard()`.

jscanify depends on OpenCV.js (the actual CV engine; jscanify itself is a
thin JS wrapper). OpenCV.js's prebuilt WASM binary is ~8-10MB — see "Bundle
size" under Risks below for how that's kept out of the main app bundle.

No alternative considered came close on the "use existing open-source code"
instruction: a from-scratch Canvas edge-detection algorithm would be
reinventing what OpenCV.js already does correctly, and a TensorFlow.js/
MediaPipe object-detection model is a much heavier dependency (and needs a
model, not just classical CV) for a problem that's really "find a rectangle,"
not "recognize an object class."

## Rendering container: full-viewport portal, not Modal/Sheet

`ui-review` flagged this as unaddressed, and it's a real gap: keeping the
same *props* doesn't settle what the component *renders into*, and the
plan's earlier drafts silently assumed the existing `<Modal size="lg">`
wrapper without checking whether it actually fits a live viewfinder.

Checked: `DeckCardScanner.jsx` today wraps everything in `<Modal>`, which
renders as a bottom `Sheet` on mobile (`Modal.jsx:87-93`) — capped at
`max-h-[85dvh]` (`Sheet.jsx:48`), with a drag handle and title header
eating vertical space (`Sheet.jsx:61-77`), built for scrollable form-like
content. A continuous camera feed doesn't want any of that. This app
already has the right precedent for "live camera capture surface":
`CardScanner.jsx:313` renders as its own full-viewport portal
(`fixed inset-0 z-[200]`), no Modal/Sheet involved.

**Decision: follow `CardScanner.jsx`'s precedent.** `DeckCardScanner`'s
render output switches from `<Modal>`-wrapped to its own full-viewport
portal, matching the pattern this app already uses for the other live
camera surface. Props (`{isOpen, onClose, onConfirm}`) stay identical —
`DeckDetail.jsx` still needs no changes — but this is a real markup change
worth calling out explicitly rather than leaving implied by "rewritten
internals."

## New/changed files

| File | Change |
|---|---|
| `frontend/src/utils/cardDetection.js` | **New.** Thin wrapper: lazy-loads OpenCV.js + jscanify once (cached singleton promise), exposes `detectCardQuad(canvas)` and `extractCard(video, quad, w, h)`. Keeps CV plumbing out of the component. |
| `frontend/src/hooks/useCameraStream.js` | **New.** `getUserMedia({video: {facingMode: 'environment'}})` lifecycle: start/stop, permission-denied state, cleanup on unmount. Checked: `frontend/src/hooks/` already exists (`useListScrollRestoration.js`, `useTheme.js`, `useTilt.js`, `useVisibleTcgdexLanguages.js`, one with its own `.test.js`) — this follows the existing convention, not a new one. |
| `frontend/src/utils/quadStability.js` | **New, pure/testable.** Given two detected quads, are they "the same card, held still" (corner-distance tolerance)? Given a stream of stable/unstable readings, has it been stable for N consecutive checks? Unit-testable without a DOM, following this repo's established `utils/*.js` + `*.test.js` pattern (see `deckChecklist.js`, `deckReview.js`). |
| `frontend/src/components/DeckCardScanner.jsx` | **Rewritten internals, and its render container changes** — see "Rendering container" above (full-viewport portal, not `<Modal>`). Video + overlay canvas replace the "Take Photo" button as the default view. State machine below. The existing candidate-picker list, inline `confirmError` banner, and `Loader2`/`Check` visual language are reused, not rebuilt. **Checked: this file currently has no test coverage at all** — see Testing below, this isn't something to preserve/match, it's a gap the plan needs to close given how much more complex the new state machine is. |
| `frontend/src/pages/DeckDetail.jsx` / `frontend/src/i18n/en.js` | **New copy needed**, not previously listed: camera-permission-denied messaging, a hint nudging "place the card on a plain, contrasting surface" (see Lighting risk below), and the undo toast's text/button label. Every prior round of work on this feature added `en.js` entries for new UI text — this should too. |
| `frontend/public/opencv/` | **New (decision needed — see Risks).** Self-hosted OpenCV.js build, or fetched at build time. |
| `backend/services/image_cache.py` | **New.** Shared URL-hash-keyed image cache (`img:{sha1(url)}`), extracted from `images.py`'s `_get_or_fetch` — see "Free disambiguation already exists: pHash" above. Used by both card-image serving and pHash's candidate downloads, so the two share cache entries instead of duplicating TCGdex fetches. |
| `backend/api/images.py` | `_get_or_fetch` becomes a thin wrapper over the new shared helper — same behavior and bytes served, cache key format changes (old rows simply age out, not migrated). |
| `backend/api/recognize.py` | `_download_candidate_images` checks/populates the shared cache before each TCGdex fetch — same async fetch it already does today, no new dependency. |
| `backend/services/deck_progress.py` | **New `unregister_scan()` function**, symmetric to the existing `register_scan()` — see Undo affordance above. Validates `card_id` is part of the deck's template, same as `register_scan` already does. |
| `backend/api/collection.py` | **New shared helper** for the `(card_id, variant, lang, condition, purchase_price, user)` matching-row lookup, extracted so `add_to_collection`'s grouping logic and the new undo endpoint call the same predicate instead of each encoding it independently — see Undo affordance above. |
| `backend/api/decks.py` | **New route** `POST /instances/{instance_id}/scans/{card_id}/undo`, `Depends(get_current_user)` — decrements-or-deletes the matching `CollectionItem` row (via the shared helper above) and the `ScannedCard` row in one transaction. |
| `frontend/src/api/client.js` | **New.** `undoLastScan(instanceId, cardId)` — thin POST. |

## State machine (inside `DeckCardScanner`)

`hunting` → `stabilizing` → `processing` → `confident` → `success`
(checkmark) → back to `hunting` (after a cooldown)

**"Auto-save" is not a new/parallel save path.** `confident` calls the
component's *existing* `confirmCard(topCandidate, key)` function
programmatically — the same function the tap-to-confirm candidate list
already calls today, with the same in-flight `confirmingKey` state and the
same `confirmError` handling on failure. Building a second, separate
auto-save code path alongside the existing tap-driven one would be a real
duplication risk (two places that can drift on how a save failure is
handled); routing through the same function avoids that outright.

Branch: `processing` → `ambiguous` → existing candidate-picker UI (tap to
confirm, same as today) → `success` or `confirmError` (existing inline
error banner, already built).

Branch: `hunting` with no camera access → `cameraDenied` → fallback to
today's file-input "Take Photo" button (see Risks — this fallback is not
optional). Visual: reuse the same error-banner treatment already in this
file for `confirmError` (`card border-brand-red/30 bg-brand-red/5
text-center py-4`, `text-brand-red` message, `btn-ghost` action —
`DeckCardScanner.jsx:111-116`) rather than a one-off style; `ui-review`
noted this was the one state left unspecified.

**Timing, reconciled to one number line** (earlier draft stated two
different, unrelated-looking numbers — this is the actual intended
sequence): `success` shows the checkmark for **~900ms**, then the loop stays
paused for a **further ~600ms** (~1.5s total from save to re-arming) before
returning to `hunting`. The combined ~1.5s is the real anti-double-capture
cooldown from "Cost/runaway-call control" below; the two aren't independent
timers.

Most of this is reused from the codebase — but `ui-review` correctly
pushed back on "mostly already in the codebase" as applied to `success`
specifically: holding a checkmark frame for ~900ms before resuming is a
genuinely new interaction pattern, not an assembly of existing pieces.
Checked both existing async-confirm flows in this app (`DeckCardScanner`'s
own `confirmCard` and `CardScanner.jsx`'s `ScanAddModal.handleAdd`) — both
go spinner → immediate reset, with a toast carrying the "it worked" signal;
neither holds a success state in the UI itself. That's fine, just worth
naming as new rather than implied-reused:
- `processing`: `<Loader2 className="animate-spin" />`, same as today's
  scanning/confirming spinners. Reused.
- `success`: `<Check />` in a green circle — **new pattern**, but not a new
  color. Use `CardStateIndicators.jsx:137-139`'s existing treatment
  (`rounded-full border border-green/40 bg-green/90 p-1 text-white` with a
  `Check` icon), the correct `green` design token and consistent with this
  file's own `badge-green` (line 154). `ui-review` checked and found three
  different greens live in this app already (the `green` token `#22c55e`;
  react-hot-toast's own success icon `#10b981`; the `hp-bar-fill.healthy`
  gradient) — citing the exact existing component avoids landing on
  whichever one the build happens to reach for first.
- `ambiguous`: today's `matches.map(...)` candidate list, unchanged. Reused.
- `confirmError`: today's inline red banner, unchanged. Reused.
- new: the live `<video>` + an absolutely-positioned `<canvas>` overlay
  (same dimensions) redrawn every detection tick with the outline path from
  `highlightPaper`.

## Free disambiguation already exists: pHash

Checked while answering a question about downloading deck images: **this
already exists**, and Phase 1 inherits it for free through the same
`recognizeCard()` → `match_card_info()` call the state machine above already
uses.

`match_card_info()` (`backend/api/recognize.py:910`) doesn't go straight
from "metadata inconclusive" to the manual candidate picker. When there are
≥2 ranked candidates with images, it downloads each candidate's card image
straight from TCGdex (`_download_candidate_images`, HTTPS-only, host-pinned
to `assets.tcgdex.net`, 5MB/50-megapixel caps), computes a 64-bit perceptual
hash of the scanned photo and each candidate locally (`_perceptual_hash` —
PIL + numpy, **no paid API call**), and accepts the closest match only if
it's clearly separated from the runner-up (`PHASH_MAX_DISTANCE=20`,
`PHASH_MIN_MARGIN=5` — abstains on a close call rather than guessing). Only
if that fails to resolve it does the code reach `should_try_visual`, the
paid Gemini/OpenAI call — gated behind `allow_visual_verification`, off by
default per scan.

**What this means for the state machine above:** by the time
`recognizeCard()` returns to `DeckCardScanner`, `confident` may already
reflect a pHash win (`_identity_decision == "phash"`), not just a metadata
win. "Ambiguous" in the state machine already means "metadata AND pHash both
inconclusive" — nothing new to build for this, it's inherited automatically.

**One real gap, now closed for Phase 2 too:** pHash needs `photo_bytes` to
run. Phase 2's OCR path crops the same card image client-side for OCR but
wasn't sending it to the new `/cards/match-text` endpoint — so an
OCR-ambiguous card would have skipped pHash entirely and gone straight to
the manual picker. Fixed in Phase 2's endpoint spec below: the cropped
image now rides along as an optional field so `match_card_info()` can still
attempt pHash on the OCR path, with `allow_visual_verification=False` (as
already specified) keeping the paid call out of reach either way.

**Caching, so this isn't a fresh TCGdex download every ambiguous scan.**
Checked: `_download_candidate_images` does its own direct fetch to TCGdex on
every call — it does **not** reuse the `ImageCache` table
`/api/images/card/{id}/{size}` already populates (`backend/api/images.py:87`,
`_get_or_fetch`). Verified the URLs can actually coincide: pHash candidates
request the `/low.webp` variant of a card's image (`recognize.py:847`), the
same convention `images.py` uses for the "small" size — so for a card whose
thumbnail was already viewed (e.g. on the deck detail page moments earlier),
pHash currently re-downloads bytes the app already has cached under a
different key.

Fix: extract `images.py`'s cache-by-URL logic into a small shared helper,
**`backend/services/image_cache.py`**, keyed purely by a hash of the image
URL (`img:{sha1(url)}`) rather than `images.py`'s current
`card:{card_id}:{size}:{url_hash}` key — the extra `card_id`/`size` prefix
was never necessary for correctness (the URL already uniquely identifies the
bytes) and is exactly what was stopping the two paths from sharing a cache
entry for the same underlying image. `images.py`'s `_get_or_fetch` becomes a
thin sync wrapper over the new helper (same behavior, same bytes, now a
shared cache); `recognize.py`'s `_download_candidate_images` checks the same
table before each fetch and stores a miss's result after — same async fetch
it already does today, added DB read/write around it, no new network client.

*Compatibility note:* changing the cache key format means existing
`ImageCache` rows (keyed the old way) simply stop being hit — not broken,
just orphaned; they can be left to age out or deleted in the same change.
This is a pure performance cache with no user data in it, so repopulating on
first hit is a fine cost, not a migration to plan around.

## Undo affordance

Decided (see "Decisions" at the end): yes, build this as part of Phase 1.

After each auto-save, show a toast with an **Undo** button (~5s) alongside
the checkmark. Tapping it reverses that specific card's scan.

**This collides with an existing toast unless the two are merged —
`ui-review` caught this, and it's every auto-save, not an edge case.**
`DeckDetail.jsx`'s `scanMutation.onSuccess` already fires
`toast.success(`${t('decks.scan.scanned')}: ${candidate.name}`)` on *every*
successful confirm — including the auto-save path, since `confident` routes
through the same `confirmCard` → `onConfirm` → this same mutation (see
State machine above, by design, to avoid a duplicate save path). Adding a
second, independent Undo toast on top means two toasts stack in the same
global `<Toaster>` (`main.jsx:30-31`) for one action. Resolution: thread an
`isAutoSave` flag through `confirmCard`/`onConfirm` so `DeckDetail.jsx`'s
`onSuccess` shows exactly one toast per confirm — the existing plain
success toast for a manual tap (unchanged), or the Undo-capable toast in
place of it (not in addition to it) for an auto-save.

**Use `toast((t) => <JSX>)`, not `toast.custom()`.** Checked: every
existing toast call in this app (`BinderDetail.jsx:464-485`,
`CardScanner.jsx:70,75`, ~20 other sites) passes a plain string to
`toast()`/`toast.success()`/`toast.error()` — none render an embedded,
independently-clickable control, so there's no direct precedent for the
Undo button's shape. `react-hot-toast` supports this two ways that look
similar but diverge silently: the function-message form
(`toast((t) => <div>…<button onClick={...}>Undo</button></div>)`)
inherits the app's dark `toastOptions` already set in `main.jsx:32-44`
(`background:#1a1a2e`, `border:#2a2a4a`); `toast.custom()` bypasses
`toastOptions` entirely and renders unstyled unless that styling is
reproduced by hand. Use the function-message form — it's the one that
keeps visual parity with every other toast in the app for free.

**This needs a small, genuinely new backend capability — verified it
doesn't already exist.** `add_to_collection` (`backend/api/collection.py:534`)
groups by `(card_id, variant, lang, condition, purchase_price, user)`: if a
matching row already exists it **increments that row's `quantity`**, it
does not always create a new row. So undo can't be "delete the row I just
created" — there may not be a new row at all. The correct inverse, checked
against the actual add path:

1. **Collection side**: find the same matching row `add_to_collection`
   would have found (deterministic — the scanner always sends the same
   defaults: `variant="Normal"`, `condition="NM"`, `purchase_price=None`).
   Decrement its `quantity` by 1; delete the row entirely if that would
   reach 0.
2. **Deck-progress side**: decrement that `ScannedCard` row's
   `scanned_quantity` by 1 (floor 0); delete the row entirely if it reaches
   0. `services/deck_progress.py` currently only has `register_scan`
   (increment, capped) — needs a symmetric `unregister_scan`.
3. Both steps in **one transaction**, so undo can't half-succeed (e.g.
   collection quantity drops but deck progress doesn't, silently
   desyncing the two numbers that are supposed to track the same scan).

New endpoint: `POST /api/decks/instances/{instance_id}/scans/{card_id}/undo`
(lives in `api/decks.py`, requires `Depends(get_current_user)` like every
sibling route). **Two checks, not one** — `reset_deck_instance`'s ownership
check alone isn't enough here, since it never validates a `card_id` at all
(it has none):
1. Instance ownership — same pattern as `reset_deck_instance`
   (`DeckInstance.id == instance_id, DeckInstance.user_id == current_user.id`).
2. **`card_id` is actually part of this deck's template** — the same check
   `register_scan` already does
   (`DeckCard.deck_id == instance.deck_id, DeckCard.card_id == card_id`)
   before touching anything. Without this second check, a request with a
   `card_id` that isn't in this deck (but that the same user owns
   elsewhere) would still pass the instance-ownership check and could
   decrement an unrelated collection item that happens to match the
   deterministic defaults — not a cross-user issue given this check, but a
   real correctness gap regardless.

If the expected matching row (collection side or deck-progress side) isn't
found — already undone, or mutated by something else since the scan —
return a clear error, not a silent no-op; the frontend should surface it
the same way `confirmError` already surfaces a failed save (see "undo
network failure" below).

The frontend only needs to remember `{instanceId, cardId}` from the scan
that just succeeded — not the created item's id — since the endpoint
re-derives the matching row the same way `add_to_collection` did.

**The Undo toast button needs the same in-flight-disable pattern already
used in this file.** The existing candidate-picker buttons disable via
`confirmingKey` while a confirm is in flight specifically to prevent a
double-tap from double-submitting — the Undo button is the same shape of
problem (a rapid double-tap could fire two undo requests, decrementing
twice for one intended undo) and should reuse that pattern, not introduce
a new one.

**Undo network failure needs its own UI state**, not silent failure — if
the undo call itself fails (network, backend down), the user is left
believing a scan was reversed when it wasn't. Mirror the existing
`confirmError` inline-banner pattern rather than leaving this unspecified.

**This is stricter than the pattern it's reversing, not a continuation of
it — worth stating explicitly.** Checked `_apply_deck_scan`
(`backend/api/collection.py:83`): its own docstring says a deck-progress
failure "must never make an already-committed collection add look like it
failed" — i.e. the existing add path *deliberately* isolates the two
tables' commits rather than making them transactional together. Undo's
single-transaction requirement is a genuinely different, stricter
consistency model than its sibling add-path uses today, not an application
of an existing convention. That's the right call for undo (a half-reversed
undo is a more confusing state than a half-applied add), but a future
reader comparing the two call sites side by side should find this
explained, not discover an unexplained inconsistency.

**The collection-side "find the matching row" predicate risks living in
two places.** `add_to_collection`'s grouping match
(`card_id, variant, lang, condition, purchase_price, user`) and undo's own
lookup would independently encode the same five-field predicate unless
factored into one shared helper both call. Otherwise a future change to
the grouping rule (e.g. a new field added to the match) could update one
call site and silently miss the other, breaking undo without any visible
error — the exact "two places that can drift" risk this plan already flags
for auto-save reusing `confirmCard` above.

This is safe to call more than once / out of order: it always decrements by
exactly 1 relative to *current* state for a specific `card_id`, never
reverts to a remembered snapshot — so undoing an old toast after scanning
more cards still does the right thing (peels off one copy of that specific
card), it just might not be what the user currently means to undo if
they've moved on. The toast auto-expiring after ~5s is the mitigation for
that, not a technical safeguard.

The undo window does **not** pause the scanning loop — `hunting` resumes on
its normal cooldown regardless of whether the toast is still showing, so
the user can keep scanning the next card while a still-live undo option
floats for the previous one.

**Needs its own test coverage**: the grouped-decrement case (row survives
at quantity ≥ 1) vs. the delete-at-zero case, on both the collection side
and the deck-progress side independently; the transaction-atomicity
property (verify a failure partway through leaves neither side changed);
**a `card_id` that isn't part of this deck's template rejected, not
silently applied to an unrelated collection row**; and a rapid double-tap
on the Undo button resulting in exactly one decrement, not two.

## Cost/runaway-call control

1. Detection loop runs on a `setInterval`/throttled `requestAnimationFrame`
   at ~150-200ms (5-6 checks/sec), not every video frame (~60fps) — plenty
   responsive for a held-still card, far cheaper on a phone's battery/CPU.
2. A card must read as the "same" quad (within a corner-distance tolerance)
   for N consecutive checks before it's considered stable enough to capture
   — filters out motion blur and mid-repositioning frames.
3. Exactly one `recognizeCard()` call fires per stable detection. The loop
   then **pauses** (not just "debounces") until either the result resolves
   or the user backs out.
4. After a successful save, detection stays paused for the ~1.5s cooldown
   described above and/or until the frame reads as "no card / low
   confidence" again — so the same physical card isn't immediately
   re-captured while the user is still swapping it out for the next one.

## Testing

This section covers state-machine and edge-case testing specifically; the
Undo affordance's own test requirements (grouped-decrement, delete-at-zero,
transaction atomicity) are specified in that section above, not repeated
here — both are pulled together as build-order steps 5-6.

- **State-machine transitions need component-level test coverage, not just
  `quadStability.js`'s pure comparator.** Checked this session:
  `DeckCardScanner.jsx` currently has zero test coverage, and the sibling
  scanner test file that does exist (`CardScannerPhoto.test.js`) only tests
  a pure helper function, not a rendered stateful component — there's no
  existing precedent in this codebase for testing a live interaction state
  machine end-to-end. Given `hunting → stabilizing → processing →
  confident/ambiguous → success → cooldown → hunting` (plus the
  `cameraDenied` branch) is meaningfully more complex than anything
  currently tested this way, this plan should establish that pattern:
  render the component with a mocked `cardDetection.js` (feed it canned
  "detected"/"stable" results) and a mocked `recognizeCard`, and assert the
  state transitions — including that `ambiguous` correctly pauses
  auto-capture, and that the loop actually returns to `hunting` after
  `success`. This doesn't require a real camera.
- Multiple/overlapping cards in frame (user holds up two cards, or one
  partially over another) isn't explicitly designed for — the assumption
  throughout is one card at a time, matching how the feature was asked for.
  Worst case a malformed/combined outline just never reads as stable long
  enough to trigger a capture, which is safe (no capture) rather than
  dangerous (wrong capture) — but it's worth including as a manual test
  case, not just an assumption.

## Risks

- **HTTPS is a hard prerequisite, and today's dev setup doesn't have it —
  this needs to be an explicit step, not just a risk paragraph.**
  `getUserMedia` only works in a secure context. I checked the running dev
  stack's own nginx access logs this session: the phone was reaching it at
  `http://192.168.68.67:3000` — a plain-HTTP LAN address. Camera access will
  silently fail to even prompt for permission from that URL on a phone
  browser. This project already documents a reverse-proxy/HTTPS deployment
  path (`docs/REVERSE_PROXY_AUTH.md`), so this isn't a redesign — but it's a
  real blocking prerequisite for step 8 below, not optional polish, so it's
  now called out as its own build-order step rather than left as a risk a
  future reader might not connect to "why can't I test this."
- **OpenCV.js bundle size (~8-10MB).** Must be lazy-loaded only when the
  deck scanner modal opens (dynamic `import()`/script injection), never
  part of the main bundle (currently ~110KB gzipped — see the frontend
  build output). Open decision: **vendor the prebuilt `opencv.js` in
  `frontend/public/`** (pinned version, no third-party CDN dependency at
  runtime — fits this app's self-hosted ethos) **vs. pull it from a CDN**
  (jsDelivr, per jscanify's own docs — smaller repo, but a self-hosted app
  reaching out to a third party every time the scanner opens, and a
  single point of failure if that CDN is unreachable). Recommend
  vendoring it, but it's a real repo-size tradeoff worth a decision before
  implementation.
- **Lighting/background dependence.** Classical contour detection (no ML)
  needs contrast between the card's edge and whatever it's resting on. This
  is inherent to the chosen approach, not a bug to fix — UI copy should
  nudge "place the card on a plain, contrasting surface" rather than trying
  to solve arbitrary backgrounds.
- **Fallback path is not optional.** `getUserMedia` can fail for reasons
  beyond HTTPS — permission denied, no camera, older browser. The existing
  file-input `capture="environment"` flow (today's entire scanner) should
  stay as an explicit fallback, not be deleted, so a user who denies camera
  access (or is on a device that can't do this) still has a working
  scanner.
- **The new endpoint (Phase 2) needs the same auth dependency as every
  sibling route.** Noted here since it applies to this phase's design
  discipline even though the route itself is Phase 2: any new route added
  under `api/` in this app carries `current_user: User = Depends(get_current_user)` —
  worth stating explicitly in a plan rather than leaving "of course it has
  auth" implicit, since forgetting it on a new route is an easy real
  mistake to make once, not a hypothetical.
- **Auto-save is a bigger trust step than today's tap-to-confirm-everything
  flow.** `_identity_confident` already gates a real behavior today (visual
  best-match reordering), but it has never been the sole gate for actually
  saving a card without a human glance. Checked what recovery exists today:
  `DeckInstance` reset (`POST /instances/{id}/reset`) zeroes **all**
  progress on that instance, not just one bad scan — so a single mis-saved
  card in a run of twenty had no lightweight recovery. Resolved: see "Undo
  affordance" above and "Decisions" below — Phase 1 now includes a per-card
  undo, not just the blunt full-instance reset.
- **Auto-saves should be distinguishable from manual confirms in the
  existing scan-trace/diagnostics system, and undo events need to connect
  back to them — one without the other doesn't meet the actual goal.**
  Resolved: `create_scan_trace()` now takes an optional `source` label
  (`"live_auto_scan"` vs `"manual"`, threaded from `DeckCardScanner.jsx`'s
  two recognize call sites through `POST /cards/recognize`), and
  `/cards/recognize` returns `trace_id` when diagnostics are enabled for
  that user. The frontend carries `trace_id` through `confirmCard` →
  `onConfirm` → `DeckDetail.jsx`'s undo toast, which passes it to
  `undo_scan` as an optional query param; `record_scan_reversed()` marks
  the original trace file's `undone_at` field. Both additions are
  best-effort and independent of the actual save/undo transactions —
  matches `_apply_deck_scan`'s own rule that a diagnostics side-effect must
  never make an already-committed action look like it failed. A crafted
  `trace_id` can't reach outside a user's own trace directory or affect
  another user's traces; verified (not just intended) that `pathlib.glob()`
  gives `..` no parent-directory meaning in a pattern, so the real risk
  `_safe()` closes off is glob-wildcard injection (a trace_id of `"*"`)
  rather than the path traversal an earlier draft of this note assumed.

---

# Phase 2: OCR-first tier, to cut the paid API call for the common case (optional follow-up)

### At a glance

- **What:** Recognize a card's printed collector number and name
  client-side (Tesseract OCR) and match them against only this deck
  instance's still-missing cards — before ever calling the paid vision
  API.
- **Why:** Phase 1 already calls the paid API once per card, but most
  cards' identity can be resolved for free from OCR plus a deck-scoped
  match (perceptual-hash comparison, or a unique number/name hit). The
  paid call becomes a fallback for the minority OCR can't confidently
  resolve, not something every card pays for.
- **Code changes:** New `cardOcr.js` (lazy-loaded Tesseract.js, parses
  OCR text into number/name fields); new deck-scoped
  `POST /instances/{id}/match-image` backend route (pHash, then a unique
  number match, then a unique name match); `DeckCardScanner.jsx` tries
  OCR + this match before falling back to the existing paid call.

Phase 1 still calls the paid vision API once per card — far cheaper than a
naive continuous-frame scanner, but not free. Explored whether that call
can be skipped for the common case by doing recognition client-side instead
and sending only text up.

## The verified backend seam

**Yes, and the backend already has the seam for it**, verified by reading
`backend/api/recognize.py`:

- `recognize_sanitized_card` (line 1057) does two genuinely separate things
  today: (1) call the vision provider with `RECOGNIZE_PROMPT` to turn an
  image into a `card_info` dict — the expensive step — then (2) hand that
  dict to `match_card_info()` (line 910), which does **deterministic**
  catalogue search + ranking (`_search_and_rank_candidates`,
  `_metadata_decision`) with **no LLM call at all**. It only escalates to a
  paid vision call (perceptual-hash / visual-verification fallback) when
  `allow_visual_verification=True` *and* the metadata alone couldn't isolate
  one candidate.
- So a new, small endpoint that builds a `card_info` dict from **OCR
  output** instead of a vision call, and passes it straight to the existing
  `match_card_info()`, gets the existing free-of-paid-API-cost deterministic-match
  path for nothing — no rewrite of the matching logic, just a new call site
  that skips step (1).
- The field that matters most for confidence — `number_local`
  (`_metadata_decision` line 558: unique number match alone is enough) — is
  short, high-contrast printed digits (occasionally with a letter prefix
  like `TG04`), one of the more OCR-friendly pieces of text on a card,
  unlike the stylized card name. That's a favorable sign for OCR accuracy
  on exactly the field that carries the most weight.
- `name_en` (the vision prompt's translated English name) has no OCR
  equivalent — but it doesn't need one: once the deterministic match
  resolves a candidate, `name_en` is read off the matched catalogue record,
  not re-derived from the image.

**Correction to "free":** checked `_search_and_rank_candidates` directly —
it does *not* query a local card catalogue at all. Every candidate search
is a live HTTPS call to the public TCGdex API
(`https://api.tcgdex.net/v2/{lang}/cards`); only `Set` metadata (name,
abbreviation, printed total) is read from the local DB. So Phase 2's
`match-text` path is free of the **paid** vision-API cost, which is the
thing worth optimizing away — but it is not offline or dependency-free: it
still round-trips to a third-party public API on every match attempt,
subject to that API's own availability. Worth stating precisely rather than
implying zero external dependency.

**Checked, no new query-injection surface:** the local DB query in this
path (`db.query(Set).filter(Set.tcg_set_id.in_(candidate_set_ids))`) is
SQLAlchemy ORM, parameterized like the rest of the app; the TCGdex call
passes the search term as an httpx `params=` value, not string-interpolated
into the URL. Phase 2 does let a client supply these text fields more
directly than today (no LLM in between) — but an LLM's output was never a
trust boundary either, so this isn't new attack surface, just a more direct
path to the same existing, already-safe query pattern. Given this is a
self-hosted app behind its own auth, exploitability here is bounded to an
already-authenticated user affecting their own instance either way.

## Revised flow

```
[live video] --(client, free)--> [outline detection, same as Phase 1]
                                          |
                                stable -> freeze + crop
                                          |
                    [client, free] OCR the crop (Tesseract.js)
                                          |
                     usable fields? --------------- OCR too sparse/garbled
                          |                                    |
              POST {fields} to /cards/match-text        fall back to Phase 1's
              (no paid API call — see "Correction        recognizeCard() (paid,
               to 'free'" above for what this            image-based) for just
               does and doesn't skip)                    this one card
                          |
              confident? ------- not confident?
                  |                    |
        auto-save, checkmark    fall back to recognizeCard() (paid) for
        (no paid API cost)      just this card, OR straight to the existing
                                 manual candidate-picker (zero cost, more taps)
```

Net effect: the paid vision call becomes a fallback for the minority of
cards OCR can't confidently resolve, not something called on every card.
The crop feeding OCR above is also sent to `/cards/match-text` for pHash
(see "Free disambiguation already exists: pHash" under Phase 1) —
confidence on this path can come from metadata, pHash, or both, with the
paid call staying reachable only as the final fallback.

## New/changed for this tier

| File | Change |
|---|---|
| `frontend/src/utils/cardOcr.js` | **New.** Lazy-loads Tesseract.js (cached worker, per-language — this app already syncs multiple TCGdex languages, so the worker language should follow the same selection used elsewhere). Exposes `recognizeCardText(cardCanvas) -> {name, number_local, number_total, set_code, hp, language}` parsed out of Tesseract's raw text/positions. **Needs its own test coverage** (sample OCR text fixtures → expected parsed fields), not just the backend matcher below — the text→structured-fields parsing (e.g. telling a local number apart from a set total, or "HP 120" vs "120 HP" vs "hp120") is real logic with real bug potential, separate from whether the backend correctly matches once it has clean fields. |
| `backend/api/recognize.py` | **New route**, e.g. `POST /cards/match-text`, thin: requires the same `Depends(get_current_user)` as every sibling route; build a `card_info` dict from the request body, call `normalize_recognized_card_info()` + `match_card_info(db, card_info, image_b64=<optional cropped-card image>, allow_visual_verification=False)`. Passing the crop is what lets pHash still run on this path when metadata alone is inconclusive (see "Free disambiguation already exists: pHash" under Phase 1) — `allow_visual_verification=False` keeps the paid call unreachable either way, so this never costs more than pHash's own free local compute. Returns the same shape `recognizeCard()` already returns (verified: `match_card_info()` itself returns the full `{recognized, matches, _number_match_count, _identity_confident, _identity_decision}` shape) so the frontend's confident/ambiguous branching doesn't need to know which path produced the result. |
| `frontend/src/api/client.js` | **New.** `matchCardText(fields, imageBlob)` — thin POST including the same cropped-card image OCR ran against, mirrors `recognizeCard()`'s upload shape. |
| `DeckCardScanner.jsx` state machine | Insert an `ocrMatching` state between `processing`(crop) and the existing confident/ambiguous branch: try OCR + `matchCardText` first; only call `recognizeCard()` (paid) if that comes back unresolved. |

## Risks specific to this tier

- **OCR accuracy is unvalidated until built.** Foil/holo glare, decorative
  name fonts, and non-Latin scripts (needs the matching Tesseract language
  pack) are all real degradation sources. This tier should be built and
  measured against real cards before trusting it as the default path —
  it's an optimization layered on a working system, not a prerequisite for
  Phase 1's UX.
- **Two WASM libraries loaded per scan session, not one.** OpenCV.js
  (detection/crop) and Tesseract.js (OCR) are both needed and both lazy —
  combined footprint is larger than Phase 1's plan accounted for. Confirm
  actual combined size before treating this as free; may be worth only
  loading Tesseract.js *after* a card is detected, not upfront with OpenCV.js.
- **`normalize_recognized_card_info()` was written assuming an LLM's
  already-cleaned JSON output.** OCR output is noisier in different ways
  (stray whitespace, look-alike character confusion like `0`/`O` or `1`/`I`
  in the collector number). Worth checking this function tolerates that
  before assuming it "just works" with OCR input unchanged.
- **This is genuinely optional and additive.** Phase 1 (live capture +
  vision call per card) is a complete, shippable feature on its own. Phase 2
  should be scoped as a follow-up once Phase 1 is live and the UX is
  validated — not bundled into the same delivery, so a stalled or
  disappointing OCR accuracy result doesn't block the core ask (spinner →
  checkmark, no more manual photo taps).

---

## Build order

**Phase 1 — live capture + vision call per card (the core ask):**

0. **Prerequisite, outside this plan's code but blocking step 8:** stand up
   HTTPS access to this app (the reverse-proxy path already documented in
   `docs/REVERSE_PROXY_AUTH.md`, or a Cloudflare Tunnel as used for the
   other project on this machine). Camera access cannot be tested from a
   phone without it.
1. **Shared image cache** (`backend/services/image_cache.py`, extracted
   from `images.py`'s `_get_or_fetch`; `recognize.py`'s
   `_download_candidate_images` checks/populates it before each TCGdex
   fetch) — see "Free disambiguation already exists: pHash" under Phase 1.
   Backend-only, independent of the camera/detection work below; no reason
   it can't land before or in parallel with step 2.
2. `cardDetection.js` + `useCameraStream.js` + `quadStability.js`, unit
   tests for the pure stability-comparison logic.
3. Rewrite `DeckCardScanner.jsx`: video + overlay, detection loop, capture →
   `recognizeCard()` → confident/ambiguous branch, reusing the existing
   candidate-picker and error-banner UI verbatim (confident routes through
   the existing `confirmCard`, not a new save path).
4. Keep the old manual-capture button as the camera-denied fallback path.
5. The shared collection-row-matching helper, `unregister_scan()` (with the
   deck-membership check), and the `.../scans/{card_id}/undo` route (with
   its own instance + deck-membership checks) — see Undo affordance above.
   Tests: grouped-decrement, delete-at-zero, transaction atomicity, an
   out-of-deck `card_id` rejected, and a double-tap producing exactly one
   decrement. Then wire the undo toast (disabled while in flight, its own
   error state on failure) into `DeckCardScanner.jsx`'s `success` state.
6. Component-level tests for the state machine itself (mocked detection +
   mocked `recognizeCard`), per Testing above — not just `quadStability.js`'s
   unit tests.
7. Multi-persona review + `ui-review` pass (established rhythm for this
   project), fix findings.
8. **Blocking, can't be substituted:** manual test on a real phone over
   HTTPS — desktop Docker testing at `localhost:3000` can validate the
   detection/state-machine logic, but not the actual phone-camera,
   real-lighting, real-card experience this feature is for. Test: several
   cards scanned back-to-back with no taps, one deliberately-ambiguous card
   (falls back to picker correctly), camera-permission-denied fallback,
   two overlapping cards presented at once (should simply never trigger a
   capture, not misfire), tapping Undo after an auto-save (confirm both the
   collection quantity and the deck's Missing/Found counts revert), and
   confirm deck progress updates end-to-end same as today for a normal
   (non-undone) scan.

**Phase 2 — OCR-first tier (follow-up, only after Phase 1 is live):**

9. `backend/api/recognize.py`: add the `POST /cards/match-text` route
   calling the existing `match_card_info()` directly, passing along the
   cropped card image (for pHash — see "Free disambiguation already exists:
   pHash" under Phase 1) with `allow_visual_verification=False` so it can
   never itself trigger a paid call. Test against the existing
   `match_card_info` test fixtures with hand-built `card_info` dicts standing
   in for OCR output, including deliberately noisy ones (wrong case, stray
   whitespace, `0`/`O` confusion) to see whether
   `normalize_recognized_card_info()` holds up unchanged or needs
   hardening.
10. `cardOcr.js` (Tesseract.js), with its own parsing-logic test coverage
    (see New/changed for this tier), wired into `DeckCardScanner.jsx` ahead
    of the existing `recognizeCard()` call, with that call as the fallback.
11. Measure against real cards before trusting the auto-save path on OCR
    output: how often does OCR + `match-text` alone resolve confidently vs.
    fall back to the paid call vs. fall back further to the manual picker.
    This number is unknown until built — treat the early results as data,
    not as validation to skip.

---

## Review findings (multi-persona + technical-writer pass)

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| TW-1 | HIGH | Phase 2 was sandwiched inside Phase 1's sections, referencing "same as Phase 1" content before that content appeared in the document | Restructured into two top-level `# Phase 1` / `# Phase 2` parts, in reading order |
| TW-2 | LOW | No upfront summary of the two-phase structure/relationship | Added roadmap paragraph after the title |
| Architect-1 | MED | "Auto-save" wasn't explicitly tied to the existing `confirmCard` function — risk of a duplicated, drifting parallel save path | State machine section, explicit note |
| Architect-2 | MED | Phase 2 described as "free" without qualifying that `_search_and_rank_candidates` still makes a live TCGdex network call | Added "Correction to 'free'" note, flow diagram updated |
| SWE-1 | MED | Two unrelated-looking timing constants (900ms checkmark, 1.5s cooldown) stated separately with no relationship given | State machine section, reconciled to one sequence |
| SWE-2 | — | Checked: does `frontend/src/hooks/` already exist as a convention? Yes, confirmed clean, not a new pattern | Noted inline in New/changed files |
| SWE-3 | LOW | No `en.js`/copy row in the file table despite new required UI text (permission-denied, background hint) | Added row to New/changed files |
| QA-1 | MED | Plan only called for unit tests on `quadStability.js`; the actual state machine (more complex, and currently 0% tested) had no test plan | New "Testing" section + build-order steps 5-6 |
| QA-2 | MED | No test coverage called for on `cardOcr.js`'s text→structured-fields parsing, only the downstream backend matcher | Added to file table + build-order step 10 |
| DBA | — | No schema/query changes anywhere in this plan; existing query paths reused unchanged | Clean, no finding |
| DevOps-1 | MED | HTTPS identified as a hard blocker in Risks but never an actual build-order step | Added as build-order step 0 |
| Security-1 | LOW | New `/cards/match-text` route didn't explicitly state it needs `Depends(get_current_user)` like every sibling route | Stated explicitly in Risks and the file table |
| Security-2 | — | Checked: does client-supplied text in Phase 2 introduce new query-injection surface? No — same parameterized ORM/httpx-params pattern as today, not a new trust boundary given an LLM was never a security boundary either | Added "Checked, no new query-injection surface" note |
| SRE-1 | MED | Auto-saves weren't distinguishable from manual confirms in any diagnostic system, despite `ScanTrace`/`trace.record_decision` already existing for exactly this | Added to Risks |
| SRE-2 | MED | No recovery for a single bad auto-save short of a full per-instance reset (all progress, not just one card) | Resolved — see Decisions below |

**Second pass (technical-writer only, after the Undo affordance was added):**

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| TW2-1 | MED | Phase 2's "Revised flow" diagram had two side-by-side text columns that visually merged into a garbled run-on line (an editing artifact from adding the "Correction to 'free'" caveat) | Simplified the diagram's box labels; the caveat's detail already lives in the prose above it, not duplicated in the diagram |
| TW2-2 | MED | "Risks / open decisions" heading was stale — the open decisions it named had already moved to a separate "Decisions" section | Renamed to "Risks"; the affected risk bullet rewritten to say "Resolved" and point there instead of "one of the two open questions below" |
| TW2-3 | MED | The "Testing" section covered only state-machine/edge-case tests; a reader going straight there would miss the Undo affordance's test requirements, specified 30 lines earlier under a different heading | Added a lead-in line cross-referencing where Undo's tests are specified |
| TW2-4 | LOW | "Undo affordance" heading carried an inline editorial aside (`(decided: yes — see Decisions at the end)`) instead of a clean noun-phrase heading | Moved the aside to the first line of body text |
| TW2-5 | LOW | The Phase 1 flow diagram didn't mention the undo toast at all (added to the document after the diagram was drawn) — a reader skimming just the diagram wouldn't know it exists | Added a one-line annotation on the auto-save branch |

**Third pass (full personas, focused on the new Undo affordance):**

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| Architect-3 | HIGH | Undo endpoint's spec said "same ownership check as `reset_deck_instance`," but that check never validates a `card_id` — `register_scan`'s existing deck-membership check wasn't carried over, so an out-of-deck `card_id` could decrement an unrelated collection row | Two explicit checks now specified in Undo affordance; test added |
| SWE-4 | MED | The 5-field collection-row matching predicate would exist independently in both `add_to_collection` and the new undo endpoint, risking drift | New shared-helper row added to the file table |
| DBA-1 | LOW-MED | Checked `_apply_deck_scan`'s docstring: the existing add-path deliberately does NOT make the collection/deck-progress commits transactional together. Undo's planned single-transaction atomicity is a stricter, different model, not "matching an existing pattern" as it read | Stated explicitly in Undo affordance |
| SRE-2 | MED | Tagging auto-saves in `ScanTrace` (from the first pass) is incomplete alone — a bad auto-save is only known bad once undone, so undo events need to connect back to the original trace entry too, or the stated goal isn't actually met | Risks section, SRE bullet rewritten |
| SRE-3 | MED | No UI state specified for the undo network call itself failing — risk of silent failure leaving the user's mental model wrong | Added to Undo affordance, mirrors existing `confirmError` pattern |
| QA-3 | MED | No test specified for an out-of-deck `card_id` being rejected | Added to test list + build-order step 5 |
| QA-4 | MED | Undo button had no in-flight-disable spec, unlike the candidate-picker buttons already in this file — risk of double-tap double-decrementing | Added to Undo affordance + test list |
| Security-3 | LOW | Undo endpoint's file-table row didn't restate the auth-dependency requirement the way Phase 2's row does | File table updated |

**Fourth pass (`ui-review` agent — UI craft, against the actual current code):**

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| UI-1 | HIGH | The new Undo toast would stack on top of `DeckDetail.jsx`'s existing `toast.success(...)` for every single auto-save (both fire on the same `confirmCard`→`onConfirm` path) — not an edge case, every confirmed auto-save | Undo affordance: `isAutoSave` flag threaded through so exactly one toast shows, not two |
| UI-2 | HIGH | Plan's "external contract stays the same" only settled props, not the render container — the video+overlay would by default land inside the existing `<Modal>`/bottom-`Sheet` wrapper (built for scrollable forms, capped height, drag handle), when this app already has a full-viewport-portal precedent for exactly this kind of surface (`CardScanner.jsx`) | New "Rendering container" section: switches to full-viewport portal, matching that precedent |
| UI-3 | MED | Undo button has no precedent in this app's ~20 existing toast call sites (all plain-string); `react-hot-toast`'s two "toast with a custom control" APIs diverge silently on styling | Specified `toast((t) => <JSX>)`, not `toast.custom()`, in Undo affordance |
| UI-4 | MED | "Green checkmark" was underspecified against three different greens already live in this app (design token, toast default, hp-bar gradient) | State machine: cites `CardStateIndicators.jsx`'s exact existing "checkmark in a green circle" treatment |
| UI-5 | MED | "Mostly already in the codebase" overstated it for `success` specifically — the ~900ms held checkmark has no precedent in either existing async-confirm flow in this app | State machine: called out as new, not reused |
| UI-6 | LOW | `cameraDenied` was the one state with no visual spec, despite being called "not optional" in Risks | State machine: reuses the existing `confirmError` banner treatment |

## Decisions

Two open questions from the review, both resolved with you:

1. **Undo affordance (was SRE-2): yes, build it.** Full design above under
   "Undo affordance" — a toast with an Undo button after each auto-save,
   backed by a new `unregister_scan()` + `.../scans/{card_id}/undo` route
   that correctly reverses `add_to_collection`'s grouped-increment
   behavior rather than assuming a row was freshly created.
2. **Initial confidence bar for auto-save: reuse `_identity_confident`
   as-is**, unchanged from what the rest of the plan already assumed — no
   stricter bar for the auto-save trigger specifically. No other section
   needed to change for this one; it confirms the existing design rather
   than altering it.
3. **pHash disambiguation: document what already exists, extend it to
   Phase 2, and share its image cache with card-image serving.** Confirmed
   with you: (a) the existing free pHash step (metadata-inconclusive →
   local perceptual-hash comparison → paid vision call only as a last
   resort) is now documented under Phase 1 rather than left undiscovered;
   (b) Phase 2's `/cards/match-text` endpoint now accepts the cropped card
   image so OCR-ambiguous cards get the same free pHash attempt Phase 1
   gets, instead of skipping straight to the manual picker; (c)
   `_download_candidate_images` and `images.py`'s card-image serving now
   share one URL-hash-keyed cache (`services/image_cache.py`) instead of
   independently re-downloading the same TCGdex images. Full design under
   "Free disambiguation already exists: pHash" above.

## Phase 2, first design (superseded 2026-08-30): implemented, then replaced

Build steps 9-10 were originally implemented as written above: `POST
/cards/match-text` (a broad TCGdex catalog search seeded by OCR fields,
narrowed by pHash), tested (`backend/tests/test_match_text.py`), and wired
into `DeckCardScanner.jsx`. It worked exactly as designed. Real-device
testing that night surfaced two things worth recording even though this
design is gone:

- OCR's `name` extraction (the field `match-text` needed to run a search at
  all) proved unreliable on real cards — a naive flat-text heuristic picked
  up mid-card noise instead of the actual name; fixed with a
  position+confidence-aware word-level picker
  (`cardOcr.js`'s `pickCardName`), documented below since it's still used.
- `normalize_recognized_card_info()` does **not** tolerate letter-O/digit-
  zero OCR confusion (a genuine "052" misread as "O52" doesn't match) —
  fixed at the OCR-specific source (`cardOcr.js`'s `cleanNumberToken`), not
  the shared matcher the trusted Gemini-vision path also relies on. This
  finding still applies to the current design (see below).

**Why superseded**: the live scanner is *always* scoped to one tracked
deck instance with a small, already-known card list — searching the whole
TCGdex catalog by OCR'd name, the way `match-text` did, was solving a
harder and less reliable problem than the one this feature actually has.
Redesigned per direct user request: OCR -> match against ONLY this deck
instance's own still-missing cards -> paid Gemini call as the last resort,
never a broad catalog search. `POST /cards/match-text` and
`test_match_text.py` were deleted, not just deprecated — replaced outright,
not layered alongside.

## Phase 2, current design: deck-scoped match

`POST /decks/instances/{instance_id}/match-image`
(`backend/api/decks.py`, tested in `backend/tests/test_deck_image_match.py`)
replaces `match-text`. Given the captured photo and this deck instance's
still-missing cards (`expected_quantity > scanned_quantity` — a card
already fully collected is excluded, since matching against it can't
change anything):

1. **pHash** (`services/phash.py`, extracted from `api/recognize.py` so
   both matchers share it) against ALL missing candidates with an image —
   no `PHASH_CANDIDATE_LIMIT` cap, unlike the broad-search matcher: a
   deck's own candidate list is already small and bounded, so capping to 8
   would silently ignore most of a freshly-started deck. Needs 2+ scored
   candidates to judge a confident margin; with fewer, this tier can't run
   at all (e.g. exactly one card left missing).
2. If pHash didn't resolve confidently: a **unique** number match among
   missing candidates (OCR's `number_local`, via the same
   `normalize_scanner_card_number` the Gemini path uses — the letter-O/
   digit-zero finding above still applies and is still fixed in
   `cardOcr.js`, not here).
3. If still unresolved: a **unique** name match — substring, not equality
   (`candidate.name.casefold() in ocrName.casefold()`), since OCR's word-
   level name output can include adjacent noise it couldn't confidently
   drop (a real "Potion" card read as "bern PRALINE Fe Potion" — the
   substring check still finds it).
4. Otherwise: not confident, falls through to `recognizeCard()` (paid).

An ambiguous number or name match (more than one candidate) is never
trusted on its own at either tier — exactly the case pHash already
declined to resolve.

**OCR scope narrowed to match**: `cardOcr.js` no longer extracts HP or
anything else — only `number_local`/`number_total` (regex on the flat
text) and `name` (`pickCardName`, word-level, position+confidence-based —
see the first-design section above for why line-level grouping and a
flat-text heuristic both failed on real cards). Neither figure is used to
search anything broader than this one deck instance's own card list.

**A total OCR failure no longer skips the free tier** — a real change from
the first design, which required a `name` to run `match-text` at all. The
deck-scoped match can resolve purely from pHash with zero OCR input, so
`DeckCardScanner.jsx` always attempts it once `deckInstanceId` is known,
regardless of what OCR did or didn't find.

**`DeckCardScanner.jsx` now requires a `deckInstanceId` prop** (from
`DeckDetail.jsx`'s own `useParams()`) — without it, this tier is skipped
entirely and every card falls straight to the paid call, matching the
component's own inline documentation.

**Verified**: 767 backend / 317 frontend tests green, including 9 new
backend tests directly exercising the deck-scoped matcher's confidence
logic (pHash win, missing-card exclusion, unique/ambiguous number match,
unique/ambiguous name match, empty-deck edge case, cross-user ownership
rejection, trace labeling). Not yet verified: real-device accuracy of this
specific design — same caveat as everything else in this document that
hasn't had a real-device pass yet.

---

# Phase 3: continuous OCR confidence feedback

### At a glance

- **What:** Turn OCR from a one-shot step into a continuous, throttled
  background readout — a live "N%" confidence badge on the collector
  number while the user is still positioning the card, updating every
  ~500-800ms instead of only after a full capture.
- **Why:** Today OCR only runs once a whole card has already been held
  steady, so a bad reading gives the user nothing to react to. A live
  percentage lets someone see low confidence and physically zoom in on
  the number to fix it — which the current design can't support at all,
  since it requires the whole card's outline in frame before it does
  anything.
- **Code changes:** A new continuous background text-reading scan — it
  reads the number roughly every half-second while you're still framing
  the card, running as its own separate OCR process so it doesn't
  compete with or interfere with the existing one-shot scan that already
  runs once a card is fully captured; a new crop that finds just the
  number on screen; a second auto-save trigger alongside today's
  whole-card one (still gated by the same match-uniqueness check, not a
  new save authority on its own); and a small backend flag so this path
  can skip pHash on a non-full-card image.

## The problem with today's shape

Verified by reading the current `DeckCardScanner.jsx`: OCR does not run
continuously today, and can't easily be made to. The detection loop
(`DETECTION_INTERVAL_MS = 90`, `DeckCardScanner.jsx:500-573`) is cheap,
local quad-finding only — it runs the whole time the user is "hunting," but
does nothing with card text. OCR (`recognizeCardText`, `cardOcr.js:166`)
only fires once, inside `captureAndRecognize` (`DeckCardScanner.jsx:401`),
which itself only fires after `REQUIRED_STABLE_FRAMES` (8 ticks, ~720ms) of
a *whole card's rectangle* being held steady. Two consequences that matter
for this phase:

1. There is no live number to react to — the first OCR result a user ever
   sees is the outcome, after the "Identifying card..." spinner.
2. The whole pipeline is anchored to `detectCardQuad`, which needs a
   complete card-shaped quadrilateral in frame (`cardDetection.js:76`).
   Zooming in far enough to read a small printed number well typically
   pushes the card's edges out of frame — at that point `detectCardQuad`
   returns `null`, `stabilityTrackerRef` never reaches
   `readyToCapture`, and today's pipeline simply never fires. The exact
   corrective action a low reading suggests (zoom in) is the one thing the
   current design can't see through.

## Decisions carried in from clarifying questions

1. **The live percentage is the collector number's own OCR read-confidence**
   (Tesseract's per-word confidence on the matched `NUMBER_PATTERN` text),
   not a combined or match-derived score. This is also the only choice that
   survives the zoom scenario itself: at the zoom level needed to read the
   number well, the name banner is usually **not** in frame at all — a
   name-weighted score would just report "unknown" at exactly the moment
   this feature exists for.
2. **Two independent trigger paths, both live**: today's quad-stability path
   (Phase 1, unchanged) stays as-is for a whole card held steady. A new
   second path fires purely off sustained high number-OCR-confidence, with
   no quad/stability requirement — this is what actually makes the zoom
   workaround usable, not just visible.
3. **The zoom-only path can auto-save from number+name alone**, no full-card
   photo required — consistent with how the existing deck-scoped matcher
   already works (`decks.py:418-452`): a *unique* number match against this
   deck's still-missing cards is sufficient on its own; pHash is one option
   among three, not a hard requirement.
4. **Perf shape, simplified after review: no separate cheap-heuristic tier
   — just throttled real OCR.** The original draft paired a cheap,
   every-tick sharpness score with a slower throttled OCR pass. Dropped:
   one signal is simpler for the user to read (no "two numbers claiming to
   mean progress" confusion) and removes a whole file plus the extra
   main-thread OpenCV cost the review flagged. Tesseract OCR — the thing
   that produces the actual percentage — runs on its own throttled cadence
   (~500-800ms), independent of the 90ms quad-detection tick, using **its
   own dedicated Tesseract worker**, not the one `recognizeCardText` uses
   at capture time (see Decision 5).
5. **A dedicated second Tesseract worker for the continuous pass**, not a
   shared/reset one. Verified against tesseract.js's own source
   (`createWorker.js`, `worker/browser/send.js`) that `setParameters` and
   `recognize` are both jobs queued on one worker, processed one at a time
   — sharing `cardOcr.js`'s existing singleton would mean a whitelist set
   for the narrow number-only call leaks into the next full-card capture
   call, and the two calls would queue behind each other instead of
   running concurrently. A second worker costs some memory but removes
   that whole bug class outright; the ~4MB `eng.traineddata` itself is
   still fetched once and shared via the same IndexedDB cache
   `cardOcr.js` already relies on — only the worker instance is
   duplicated, not the language-data download.
6. **The throttled OCR pass is strictly serial**: never start a new pass
   while the previous one is still in flight. This is a stronger version
   of a plain "skip if busy" guard — because at most one pass can ever be
   outstanding, passes cannot resolve out of order, which removes the need
   for a separate generation-counter/staleness check entirely.
7. **Auto-trigger threshold: number-OCR-confidence ≥ 80%, sustained for 3
   consecutive throttled passes, and regex-valid** (`NUMBER_PATTERN`)
   before attempting the deck-scoped match — mirroring Path A's own
   "sustained, not instantaneous" philosophy (8 consecutive detection
   frames there; 3 consecutive OCR passes here, on a much slower ~500-800ms
   cadence). This is a gate on **when to attempt**, not authority to save:
   the actual auto-save still requires the existing uniqueness check
   (unique number/name match, or pHash) — a clean, confidently-read
   misread could otherwise land on a different card that's also missing
   from the deck, and 80%/3-passes doesn't protect against that on its
   own. Like `cardOcr.js`'s existing `NAME_BAND_FRACTION`/
   `MIN_NAME_CONFIDENCE`, these are reasoned starting points to tune
   against real devices, not empirically validated numbers.
8. **Added per real user feedback on the badge design (artifact comment,
   2026-08-31): show a name preview once the number uniquely resolves,
   separate from the percentage itself.** The percentage staying
   number-read-confidence (Decision 1) is still correct — it's the only
   signal that survives the zoom scenario — but that doesn't mean the
   badge has to be silent about identity. This deck instance's own
   still-missing cards (number → name pairs) are cheap, already-loaded
   data: `DeckDetail.jsx` fetches this list today to render the missing-
   card checklist, it just isn't currently threaded down into
   `DeckCardScanner.jsx`. The moment the OCR-read number matches exactly
   one entry in that list — a plain client-side lookup, no network call,
   no dependency on crossing the 80%/3-passes auto-trigger threshold — the
   badge can show that candidate's name as a preview: the percentage and
   number on one line ("72% — 025/198"), the bare name on a second,
   visually secondary line ("Pikachu") — no hedging phrase like "looks
   like" prefixed to it (dropped per your comment); the smaller/secondary
   styling itself is what signals "preview, not confirmed," not the
   wording. If the number is still ambiguous or
   matches nothing missing, no name shows, same as today's design. This
   is additive and low-risk: it never changes when Path B actually
   fires or saves (still gated by Decision 7's real match+uniqueness
   check, not this preview lookup), it just answers "is this heading
   somewhere useful" earlier and more concretely than a bare percentage
   can.

## Revised flow

Redrawn per your comments — Path A included in full this time, tree only
with no annotations inline; every detail that used to live inside a box
is explained below it instead.

```
quad detected & held steady?
  |
  ├─ yes ──► Path A (Phase 1/2, unchanged)
  |            |
  |            capture the card
  |            |
  |            OCR + deck-scoped match
  |            |
  |            confident? ──yes──► auto-save
  |              |
  |              no
  |              |
  |            paid vision API (fallback)
  |              |
  |              confident? ──yes──► auto-save
  |              |
  |              no ──► candidate picker (manual)
  |
  └─ no / zoomed in ──► Path B (new, this phase)
               |
               crop the number region
               |
               throttled OCR pass
               |
               live badge: confidence % + number
               (+ name, once it uniquely matches
                a missing card — see below)
               |
               sustained high confidence?
               |
              yes
               |
               deck-scoped match
               (number + name only, no photo)
               |
               ├─ unique match ──► auto-save
               |
               └─ ambiguous/none ──► keep scanning
```

**Quad detection** is Phase 1's existing 90ms loop, untouched.

**Path A** is the existing whole-card flow (Phase 1/2), unaffected by
anything in this phase: capture once the card's held steady, run OCR and
the deck-scoped match (pHash, then number, then name — see Phase 2), and
call the paid vision API only if none of those resolve confidently.
Either confident outcome auto-saves the same way; a fully unresolved card
falls back to the manual candidate picker.

**Path B** is what this phase actually adds, for when the card's edges
are out of frame (zoomed in on just the number) and Path A's quad
detection has nothing to hold onto.

**Throttled OCR pass**: runs roughly every 500-800ms, not on every video
frame. Strictly serial — never starts a new pass while one is still
running — on its own dedicated Tesseract worker, separate from the
one-shot scan Path A uses at capture time (see Phase 3's "At a glance"
for why they're kept apart).

**Live badge**: the percentage is the number's OCR read-confidence, not
"confidence this is your card" (see Decision 1 — a match-based score
would go blank in exactly this zoomed-in scenario). The name preview is
independent of the confidence threshold below it — it appears the
instant the number uniquely matches one of this deck's still-missing
cards, computed locally with no network call (Decision 8).

**Sustained high confidence** means ≥80% for 3 consecutive passes, not
one lucky frame (Decision 7) — this gates *when* to attempt a match, not
whether to trust it. Once it fires, the throttled pass pauses (mirrors
Path A's own capture-then-pause) until that attempt resolves.

**Path B's match** hits the same deck-scoped matcher Path A uses, but
skips the image-comparison step (pHash) since there's no full-card photo
here to compare — just the number and name, checked for a unique match
against this deck's missing cards. An ambiguous or no match resumes
scanning; a unique match auto-saves through the same save path Path A
already uses, not a second one.

## Observability: what's actually in the logs

Checked directly against the current code, per your comment — the
answer today is **only the final outcome, not each step**:

- **Client-side steps (quad detection, both OCR passes) never reach
  server logs at all** — they run entirely in the browser. The only
  visibility into them is the on-screen debug overlay (raw OCR text,
  per-word confidence, tick counts — see Phase 4's diagnostics toggle),
  which is on-device and ephemeral, not searchable or persisted anywhere.
  That's an inherent boundary of where those steps run, not a gap this
  phase can close without adding client-to-server telemetry — a real
  scope increase this plan isn't proposing.
- **The deck-scoped match** (`match_deck_image`, `decks.py:459`) already
  has one plain, always-on `logger.info(...)` line — visible in plain
  `docker logs`, no opt-in required — but verified it logs only the
  *final* decision (`confident`, `decision`, `winner`), not which tier
  was tried and rejected along the way. That per-tier detail (e.g. exact
  pHash distances) only exists in the opt-in `ScanTrace` system.
- **Real, fixable gap this phase introduces**: that same log line doesn't
  include `source` or `skip_phash` — so today, a Path A call and a future
  Path B call would be indistinguishable in plain logs, and there'd be no
  way to tell from the log alone whether pHash even ran for a given
  attempt. Fixing this: Path B's calls pass a distinct `source` (e.g.
  `"live_zoom_scan"`, vs. Path A's existing value), and both fields get
  added to the existing log line — so "was this Path A or Path B, and did
  pHash run" is visible in plain logs for every attempt, not just
  something you can reconstruct from the opt-in trace after the fact.
- **The paid vision API call** is already well logged (success with
  model/duration, and — a recent fix — the actual response body on a
  transient failure, not just its status code), so nothing new needed
  there.

## New/changed files

| File | Change |
|---|---|
| `frontend/src/utils/cardOcr.js` | **New export**, e.g. `recognizeNumberRegion(canvas)` — a second, narrower Tesseract call restricted to a digit/slash/letter character whitelist (Tesseract's `tessedit_char_whitelist`, unused today) for speed, distinct from the existing full-card `recognizeCardText` used at capture time. **Decided (resolves M-1 in Review findings): runs on its own dedicated worker**, not `ensureWorker()`'s existing singleton — see Decision 5 above for why sharing it was rejected (stateful whitelist, serialized jobs). |
| `frontend/src/utils/numberBand.js` | **New.** Given either a detected quad+source or, when no quad exists (zoomed past the edges), the raw video frame, returns the crop to feed the throttled OCR pass. Bottom-left band heuristic when a quad exists (mirrors `cardOcr.js`'s existing top-band heuristic for the name); a periodic wider/full-frame fallback (see Risks) when nothing has been read for several passes in a row, so a nonstandard layout doesn't get stuck at 0% forever. |
| `frontend/src/pages/DeckDetail.jsx` | **New prop threaded through**, e.g. `missingCards` — this page already fetches the deck instance's full missing-card list (number/name pairs) to render the checklist; pass that same array into `DeckCardScanner` so the name-preview lookup (Decision 8) can run client-side with no new fetch. |
| `frontend/src/components/DeckCardScanner.jsx` | New continuous-loop state (`liveNumberConfidence`, `liveNumberText`, consecutive-high-confidence-pass count) and **its own strictly-serial in-flight ref for the throttled OCR pass, separate from the existing `tickInFlightRef`** — see S-1 in Review findings: `tickInFlightRef` guards the 90ms detection tick itself, and awaiting a several-hundred-ms Tesseract call inside it would stall quad detection, defeating the whole point of throttling OCR separately. Strictly-serial (never start a new pass while one is in flight — Decision 6) resolves S-2's stale-result race by construction, no separate generation counter needed. New Path B branch alongside the existing stability branch, firing **once** when confidence sustains ≥80% for 3 consecutive passes (Decision 7), then pausing until resolved (A-1/R-1) — both branches call the same `confirmCard`, not a second save path. Also derives a **name preview** (Decision 8) from the new `missingCards` prop: a plain array lookup on every OCR pass, independent of the auto-trigger threshold — a UI-only concern, not part of the trigger/save logic above. |
| `backend/api/decks.py` | `match_deck_image` gets a new optional `skip_phash: bool = Form(default=False)`. When true, skip straight to the number/name-unique tiers — see "pHash false-positive risk" below for why this is needed, not optional polish. **Also**: its existing plain `logger.info(...)` line (`decks.py:459`) gets `source` and `skip_phash` added as logged fields, so Path A vs. Path B and whether pHash ran are visible in plain logs per attempt — see Observability above. |
| `frontend/src/api/client.js` | `matchDeckImage` gets the new optional flag threaded through. |
| `frontend/src/i18n/en.js` | New copy: the live confidence readout's label — pairs the number with "read quality," not "match confidence" (P3-6, avoids the framing M-2 already warns against) — the dynamic hint text that swaps in during low confidence (e.g. "Low confidence — try zooming in on the number"), replacing rather than joining the existing `liveHint` string (P3-1); and the name-preview string — the bare matched name, no hedging phrase like "looks like" (Decision 8). |
| `backend/tests/test_deck_image_match.py` | **Existing file needs updating, not just new coverage added.** Verified: every one of its ~10 direct calls to `match_deck_image(...)` already spells out every `Form(...)` parameter explicitly (e.g. `number_local=None, name=None, source=None`) because this file's own docstring warns that a direct call omitting a `Form(...)` param gets FastAPI's sentinel object, not its Python default. Adding `skip_phash` means every one of those call sites needs `skip_phash=False` added too, or they break on the first run after the param lands — see Q-3/D-1 in Review findings. |

## Risks (devil's advocate pass)

- **Simplified after review: no separate sharpness heuristic.** The
  original draft paired an every-tick Laplacian-variance blur score with
  the throttled OCR pass, as a cheap "hold steady" cue. Dropped per
  Decision 4 — it wasn't an OCR-readiness predictor anyway (couldn't
  detect glare or a tilted-but-sharp number), it added main-thread OpenCV
  cost to an already-budgeted 90ms tick, and two numbers competing to mean
  "progress" was worse for the user than one. The throttled real-OCR
  percentage is now the only live signal.
- **Tesseract runs in a Web Worker** (verified: `createWorker` in
  `cardOcr.js:21`), so the throttled real-OCR pass won't block the
  main-thread detection loop — but a phone still has few CPU cores, and
  running quad detection (main thread) and OCR (worker) concurrently for
  the entire time a user is positioning a card is real, sustained load, not
  today's brief one-shot cost. Per Decision 6, the throttle is **strictly
  serial** (never start a new pass while the last hasn't resolved), not a
  bare `setInterval` — on a struggling phone this means passes simply
  space out further rather than backing up into a queue of overlapping
  calls, which also happens to be what removes the stale-result race S-2
  originally flagged (at most one pass in flight, so none can resolve out
  of order).
- **pHash false-positive risk on a partial image — this is why
  `skip_phash` is a real requirement, not a nice-to-have.** `match_deck_image`
  (`decks.py:342`) requires an uploaded `file` unconditionally and runs
  pHash unconditionally whenever ≥2 missing candidates have images
  (`decks.py:402`) — it has no concept of "this image isn't a full card."
  Sent a number-only crop as `file` without `skip_phash`, pHash would
  compute a perceptual hash against a zoomed, cropped, non-full-card image
  and could — by chance — land closer to the wrong candidate than to no
  candidate at all, producing a **confident but wrong** auto-save. This
  isn't a hypothetical: pHash's own margin check
  (`PHASH_MAX_DISTANCE`/`PHASH_MIN_MARGIN`) is tuned against real full-card
  photos, not fragments, so its false-positive behavior on a fragment is
  unvalidated. The frontend must set `skip_phash=true` on every Path B
  call, not rely on pHash naturally declining to match.
- **OCR read-confidence is not identification confidence — Decision 7
  mitigates this, but it's worth stating plainly, with a concrete failure
  mode.** A high Tesseract confidence means "I'm sure I read these
  characters correctly," not "this is definitely your card." A clean,
  confidently-read misread (e.g. `052` misread as `057`) can still collide
  with a *different* card that's also missing from the deck — 80%/3-passes
  doesn't rule that out by itself. The design treats sustained high OCR
  confidence as a **gate on when to attempt** the (already
  unique-match-only) deck-scoped match — never as sufficient to save by
  itself — which is the right mitigation, but it should stay that way
  through implementation: nothing should shortcut straight from "OCR% is
  high" to "save," skipping the uniqueness check.
- **Number-band heuristic reliability.** Not every set prints the number in
  the same bottom-left position `cardOcr.js`'s existing name-band heuristic
  assumed for the top. `numberBand.js` needs a fallback — e.g. widen to a
  larger region (or the full frame) every 3rd throttled pass if nothing
  regex-valid has been read yet — so a layout the heuristic guessed wrong
  doesn't get permanently stuck at 0% instead of just taking longer.
- **State-machine interference.** The new continuous OCR loop must not
  read or reset `stabilityTrackerRef`/`awaitingCardRemovalRef` — those
  belong entirely to Path A. As a user zooms in, `detectCardQuad` will
  transition from finding a quad to finding none; that transition is
  expected and must not visibly disrupt the accumulating number-confidence
  readout, which is tracking a different thing (OCR text) than quad
  presence.
- **Battery.** Gate the whole continuous-OCR loop behind `phase === 'hunting'`
  (same gating the existing detection loop already uses) so it stops the
  instant a capture/save is in flight — matches existing lifecycle, not a
  new pattern. **Checked, not just flagged as open: no `document.visibilitychange`
  handling exists anywhere in this codebase's camera/detection code today**
  (`useCameraStream.js`, `DeckCardScanner.jsx`) — the only hit in the whole
  frontend is unrelated (`CardImage.jsx`'s lazy-loading). Phase 3 doesn't
  need to fix this pre-existing gap, but it's a real, verified one this
  phase inherits (a backgrounded tab keeps running the throttled OCR loop),
  not an unknown.
- **This is additive, per your answer to "trigger change" — not a
  replacement.** Path A (today's whole-card flow, real-device tested) does
  not change. Path B is new and starts unvalidated on real devices, same
  caveat every other tier in this document carries until measured.
- **Path B's trigger must fire once, not repeatedly, while confidence stays
  high — otherwise this phase quietly multiplies backend load per card.**
  `match_deck_image` writes a `ScanTrace` file unconditionally on every
  call (`trace.set_image(...)`, `decks.py:390`, before any matching logic
  runs) — verified this has no existing rate limit of its own. If the
  "sustained >= threshold" trigger re-fires on every throttled pass (every
  ~500-800ms) for as long as a user holds a good zoom while deciding what
  to do next, that's several trace files and DB match attempts per second
  for one physical card, with nothing today that would page anyone about
  the resulting disk growth. The flow diagram above and the file table's
  `DeckCardScanner.jsx` row now specify **fire once, then pause until
  resolved** — the same shape Path A's own capture already uses — as a
  requirement, not an implementation detail to sort out later.
- **Resolved: `ensureWorker()`'s single cached Tesseract worker will NOT be
  shared with the new continuous pass — see Decision 5.** Originally
  flagged (M-1) as a real risk if reused unchanged: `createWorker.js`'s
  `setParameters` and `recognize` are both jobs posted to one worker
  (verified in `node_modules/tesseract.js`), processed one at a time, with
  `setParameters` persisting across subsequent jobs — so a shared worker
  would have let the narrow number-only whitelist silently leak into
  Path A's full-card capture-time OCR, and made the two calls queue behind
  each other. A dedicated second worker for the continuous pass removes
  both problems outright, at the cost of a second worker's memory
  footprint (not a second trained-data download — the ~4MB
  `eng.traineddata` is still shared via `cardOcr.js`'s existing IndexedDB
  cache).
- **Tesseract's `confidence` score is not a calibrated probability, and
  it's specifically unreliable on the character classes this feature cares
  about most.** It's an internal engine heuristic, and this codebase
  already has to correct for it scoring plausible-but-wrong reads on
  exactly the confusable characters a collector number contains
  (`cardOcr.js`'s existing `cleanNumberToken`, fixing O/0 and I/l/1
  confusion after the fact — not a hypothetical, a documented real finding
  from this project's own Phase 2 build). Showing a raw Tesseract
  confidence to a user as "N%" implies more certainty than the engine
  itself guarantees. The plan's structural mitigation (a gate on *when* to
  attempt a match, never proof of one — see Decision 7 above) is the right
  fix technically, but the UI copy should avoid language like "78% sure
  this is your card," which the number doesn't actually support.
- **The character whitelist is a plausible but unvalidated speed/accuracy
  tradeoff, not a pure win.** Restricting `tessedit_char_whitelist` to
  digits/slash/letters does cut misreads into wrong character classes and
  speeds up recognition — but it also narrows the engine's own search
  space, so a badly-focused or glare-affected number can get forced into
  the closest whitelisted-looking answer with an artificially **inflated**
  confidence, rather than correctly reporting a low one. Worth a real-device
  check of whether the whitelist makes bad reads look falsely confident
  before trusting it, same "unvalidated until measured" caveat already
  carried by everything else in this phase.

## Testing

- **`numberBand.js`** (the region-selection math) is genuinely pure and
  testable the same way `quadStability.js` is today — plain coordinates in,
  a crop rectangle out.
- **A serial-guard test**: assert the throttled OCR loop skips starting a
  new pass while one is still in flight, rather than queuing or overlapping
  it. This is what makes a separate stale-result-race test unnecessary
  (Decision 6) — with at most one pass ever outstanding, there's no
  "two passes resolve out of order" case left to test.
- **A sustained-threshold test**: a single pass at ≥80% must NOT trigger
  Path B; three consecutive passes at ≥80% must. Covers the "one lucky
  noisy frame" case Decision 7 exists to rule out.
- Backend: a test asserting `skip_phash=true` skips the pHash block even
  with ≥2 image-bearing candidates present. **Every existing call site in
  `test_deck_image_match.py` needs `skip_phash=False` added explicitly**
  (see the file table above and Q-3/D-1 in Review findings) — not just "the
  existing coverage re-run unchanged," since it won't run at all against
  the new function signature otherwise.
- Manual, real-device (blocking, same as every prior phase in this
  document): zoom into just the number with the card's edges out of frame
  and confirm Path B fires and auto-saves correctly; confirm Path A
  (whole-card, unchanged) still works exactly as before; deliberately hold
  a blurry/moving frame under the number long enough to confirm noise
  doesn't cross the confidence threshold and cause a spurious save; confirm
  the live percentage doesn't feel jumpy/distracting during ordinary
  positioning before a card is even close to readable; hold a good zoom
  steady for several seconds after a confident match already fired and
  confirm no further `match-image` calls go out until the next physical
  card (A-1/R-1); if a stability-triggered capture (Path A) happens to land
  while a throttled number-only pass is still in flight, confirm the
  capture's own OCR isn't visibly delayed (verifies the dedicated-worker
  decision actually avoided the queuing it was meant to avoid); and,
  against a deck with two missing cards whose numbers are a plausible OCR
  misread of each other, confirm a misread never auto-saves the wrong one
  (the uniqueness check, not the 80%/3-passes gate, is what should catch
  this).

## Build order

12. `numberBand.js`, unit-tested independently of the component.
13. `cardOcr.js`'s `recognizeNumberRegion`, char-whitelisted, on its own
    dedicated Tesseract worker per Decision 5 (not `ensureWorker()`'s
    singleton) — tested against fixture text the same way
    `parseCardOcrText`/`pickCardName` already are.
14. Backend: `skip_phash` flag on `match_deck_image`, tested both ways —
    including updating every existing direct call site in
    `test_deck_image_match.py` to pass `skip_phash=False` explicitly
    (Q-3/D-1), not just adding new cases.
15. Wire the continuous loop into `DeckCardScanner.jsx`: live percentage
    UI, a strictly-serial throttled-OCR in-flight guard kept separate from
    the existing `tickInFlightRef` (S-1, and this serialization is what
    resolves S-2 by construction per Decision 6), and a Path B trigger that
    fires once when confidence sustains ≥80% for 3 consecutive passes
    (Decision 7) and then pauses until resolved (A-1/R-1) — calling the
    existing `confirmCard`, not a second save path. Multi-persona +
    `ui-review` pass, per this project's established rhythm.
16. Real-device test per the Testing section above — this phase's accuracy
    and "does it actually feel useful, not distracting" verdict is unknown
    until measured, same as Phase 2's own numbers were. This includes
    calibrating the 80%/3-passes threshold itself, which is a starting
    guess, not a validated number.

## Review findings — Phase 3 (multi-persona + OCR-model-expert pass)

Seven-lens review (Architect/SWE/QA/DBA/DevOps/SRE/Security) plus an added
OCR/vision-model-domain lens — no dedicated skill for that is registered in
this project, so it's folded in here as an eighth lens (tag `M`) rather than
skipped, since this phase's risk is substantially about Tesseract's actual
engine behavior, not just general code quality.

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| M-1 | HIGH | `ensureWorker()`'s single cached Tesseract worker is shared, stateful state — verified in tesseract.js's own source, not assumed: `setParameters`/`recognize` are both jobs queued on one worker, so a char-whitelist set by the new narrow OCR call would persist onto the next full-card call, and the two calls can't run concurrently | Resolved by decision — see "Phase 3 decisions" below (dedicated second worker); build-order step 13 |
| A-1 | HIGH | Path B's match trigger cadence was unspecified — read as firing on every throttled pass while confidence stayed high, not once | Flow diagram annotated "fires once, then pauses"; new Risks bullet; build-order step 15 |
| Q-1 | HIGH | Testing section incorrectly claimed `cardSharpness.js` follows the same pure-unit-test convention as `quadStability.js` — verified they're categorically different (plain coordinates vs. real WASM pixel data) | Moot — `cardSharpness.js` was cut entirely in the simplification pass below; `numberBand.js`'s pure region math is the only unit-testable piece left, build-order step 12 |
| Q-3 / D-1 | MED | New `skip_phash` Form param breaks every existing direct call site in `test_deck_image_match.py` unless each is updated — verified all ~10 sites already spell out every `Form(...)` param explicitly, for exactly this reason | New file-table row for the test file; Testing section corrected; build-order step 14 |
| S-1 | MED | Throttled OCR pass needs its own in-flight guard, separate from `tickInFlightRef` — awaiting it inside the existing guard would stall the 90ms detection tick it's meant to run alongside | File-table row + build-order step 15 |
| S-2 | MED | No guard specified against an out-of-order-resolving OCR pass overwriting a fresher result | Resolved by decision — see "Phase 3 decisions" below (strictly-serial guard makes overlap, and so staleness, structurally impossible); build-order step 15 |
| R-1 | MED | Same root cause as A-1, from the operational-load angle: `match_deck_image` writes a `ScanTrace` file unconditionally on every call, with no existing rate limit — a repeating (not one-shot) trigger multiplies trace-file and DB-match load per physical card | Same fixes as A-1; new Risks bullet naming the disk-growth blast radius explicitly |
| M-2 | MED | Tesseract's `confidence` is an uncalibrated engine heuristic, specifically unreliable on the O/0, I/l/1 confusions this app already corrects for post-hoc — showing it raw as "N%" overstates certainty | New Risks bullet; UI-copy caution noted for build-order step 15 |
| M-3 | LOW | Character-whitelisting speeds up OCR but could also inflate confidence on a genuinely bad read by narrowing the answer space, rather than being a pure win | New Risks bullet, flagged as unvalidated-until-measured like the rest of this phase |
| R-2 | LOW | Plan hedged "unverified" on whether `document.visibilitychange` is handled anywhere in this codebase's camera code | Checked directly — confirmed not handled anywhere relevant; wording corrected from "unverified" to a stated, verified gap |
| S-3 | LOW | `getCv()`'s proposed semantics (return the already-initialized instance vs. re-run loading) were left implicit | Moot — see below: `cardSharpness.js` (its only caller) was cut, so `getCv()` is no longer needed at all |
| B | — | No schema/query changes anywhere in this phase | Clean, no finding |
| X | — | Checked explicitly: `skip_phash` doesn't bypass `Depends(get_current_user)` or `_get_owned_instance`'s ownership scoping — it only selects which already-scoped matching tier runs, and isn't interpolated anywhere. No new injection or cross-user surface | Clean, stated as a checked conclusion rather than skipped |

## Phase 3 decisions (post-review simplification pass)

Confirmed with you after the review above. All four resolve or sidestep a
finding from the table rather than ignoring it:

1. **Drop the sharpness heuristic entirely** (no `cardSharpness.js`, no
   `getCv()` export). One live signal (throttled OCR confidence) instead of
   two. Removes the main-thread-cost concern the review raised about
   running a Laplacian pass every 90ms, and makes S-3 moot outright rather
   than needing an answer.
2. **The continuous OCR pass gets its own dedicated Tesseract worker**,
   not `ensureWorker()`'s shared singleton. Directly resolves M-1 (stateful
   whitelist leaking across calls; jobs queuing instead of running
   concurrently) by removing the sharing that caused it, at the cost of a
   second worker's memory footprint.
3. **The throttled OCR pass is strictly serial** (never starts a new pass
   while one is in flight). Resolves S-2 (stale out-of-order results) as a
   side effect, not a separately-built fix — with at most one pass ever
   outstanding, there's nothing left to resolve out of order.
4. **Auto-trigger threshold: OCR confidence ≥80% on the number, sustained
   for 3 consecutive throttled passes, regex-valid** — a gate on *when* to
   attempt the existing deck-scoped match, not authority to save by itself
   (the uniqueness check still owns that decision, per M-2/the
   misread-collision risk above). Both numbers are starting points to
   calibrate on a real device, not validated thresholds.

A-1, R-1, Q-1, Q-3/D-1, M-2, M-3, and R-2 from the table above were already
addressed in the Phase 3 text directly (flow diagram, file table, Risks,
and Testing sections) and didn't need a decision here — only the four
above required an explicit choice between named alternatives.

---

# Phase 4: user-configurable scanner tuning

### At a glance

- **What:** Turn the hardcoded detection/OCR tuning constants (how long a
  card must hold steady, Phase 3's auto-trigger confidence threshold)
  into user-editable settings — a Fast/Balanced/Careful preset plus an
  Advanced section with the raw values, alongside two related toggles
  (diagnostics visibility, auto-save vs. always-confirm).
- **Why:** The right tuning genuinely depends on the phone's own camera
  and CPU, not just taste — a value tuned for a fast phone can make an
  older one's scanner worse, not better. Needed per-device, but with an
  account-level default so a freshly-opened device isn't starting blind.
- **Code changes:** Two new `UserSetting` keys (account-level default)
  plus a `localStorage`-backed per-device override with its own
  resolution/precedence logic; a new sibling settings card (not appended
  to the existing, already-dense one); `DeckCardScanner.jsx`'s hardcoded
  constants become resolved runtime values, and the always-on debug block
  gets gated behind the new diagnostics toggle.

Gated on Phase 3, since it exposes Phase 3's auto-trigger threshold as well
as Phase 1's existing quad-stability constants.

## Why this needs a real design, not just exposing some sliders

Verified: today's tuning is hardcoded module-level constants in
`DeckCardScanner.jsx` (`DETECTION_INTERVAL_MS = 90`,
`REQUIRED_STABLE_FRAMES = 8` → ~720ms dwell, `STABILITY_TOLERANCE_PROPORTION
= 0.07`), tuned specifically against real-device testing (see the file's
own build-history comments on autofocus settling). Phase 3 proposes two
more (80% confidence, 3 consecutive passes). Making these user-editable
raises a question the existing scanner-settings screen doesn't have to
answer: **where does the value live?**

Checked the existing pattern first: `ScannerSettingsCard.jsx`'s
provider/model/API key settings are backed by `UserSetting`
(`user_id` + key/value, `models.py:497`) — account-level, synced to every
device that account logs into. That's correct for "which AI provider" (an
account-level choice) but wrong for camera/detection tuning, which depends
on a specific phone's camera and CPU — syncing a value tuned on a fast
phone onto an older device on the same account would silently make that
device's scanner worse, not better.

## Decisions (confirmed with you)

1. **Two-layer storage: an account-level default, overridable per device.**
   The account-level value (new `UserSetting` key) is what a fresh device
   sees before it's been tuned locally — useful the first time someone
   opens the scanner on a new phone. A per-device `localStorage` value, when
   present, wins over the account default for whichever fields it sets.
   This is real, additional complexity over either flavor alone (two
   storage layers, a merge/precedence rule) — accepted deliberately because
   neither single-layer option was actually correct for this specific data.
2. **Presets as the primary control, with an Advanced section exposing raw
   values** — mirrors this app's own existing precedent
   (`ScannerSettingsCard.jsx`'s admin-only "Advanced model" section). Most
   users pick Fast/Balanced/Careful; a preset choice is itself just a
   named bundle of the same raw values Advanced exposes directly.
3. **"Balanced" is defined as exactly today's shipped values** — 720ms
   dwell, 0.07 tolerance, 80%/3-passes. Anyone who never opens the new
   settings screen gets identical behavior to what's already been
   real-device tested; this phase changes nothing by default.
4. **Not everything new belongs in the device-override bucket.** Two
   related-but-different settings ride along on the same screen and need
   different homes:
   - **"Show scanner diagnostics"** (the always-on debug text block at
     `DeckCardScanner.jsx:761-787` — raw OCR text, tick counts, per-word
     confidences — verified it renders unconditionally today, with no
     existing toggle) is a personal preference disconnected from device
     hardware. Per-device `localStorage`, off by default — simplest
     option, and there's no reason a preference like this should sync.
   - **"Auto-save when confident" vs. "always confirm before saving"** is a
     trust posture, not a hardware property — it doesn't get better or
     worse based on which phone is being used. Account-level
     (`UserSetting`), alongside provider/model.

## Config resolution and value bounds

For each of the four tunable fields (dwell ms, tolerance proportion,
auto-trigger confidence %, auto-trigger consecutive passes), resolution
order is: **per-device override (if that specific field is set) → account
default (preset-derived, or the stored custom values if the account's
preset is `"custom"`) → hardcoded factory constant** (the current Phase
1/3 values, used only if the account setting hasn't loaded yet). A partial
device override (a user only tweaked the confidence threshold locally, say)
must merge field-by-field, not replace the whole config wholesale — this
matters because there's no other way to change one field per-device without
duplicating every other value onto that device too.

Illustrative preset values (starting points, not validated — same caveat
every other threshold in this document carries):

| Preset | Dwell | Tolerance | Auto-trigger confidence | Consecutive passes |
|---|---|---|---|---|
| Fast | ~500ms | 0.09 | 75% | 2 |
| **Balanced (default)** | **~720ms** | **0.07** | **80%** | **3** |
| Careful | ~1080ms | 0.05 | 88% | 4 |

**Every raw field needs a clamped valid range, enforced on both save paths
(the account endpoint and the local override), not just the UI slider's
own min/max.** A garbage value (dwell near 0, tolerance near 1.0) wouldn't
just misbehave — it could make the scanner unusable, or spam auto-trigger
attempts. Suggested bounds (also unvalidated): dwell 300-2000ms, tolerance
0.03-0.15, confidence 50-95%, consecutive passes 1-6. The auto-trigger's
own uniqueness-check gate (Phase 3, Decision 7) still bounds the actual
damage a reckless custom value can do — a low threshold produces more
*attempts*, not more *wrong saves* — but more attempts still means more
`ScanTrace` writes and DB calls (same R-1 concern Phase 3 already flags),
so validation is still worth doing, not just relying on that downstream
gate.

## New/changed files

| File | Change |
|---|---|
| `backend/models.py` | No new table — reuses existing `UserSetting` (`user_id`, `key`, `value`) with two new keys: `scanner_tuning` (JSON: `{preset, custom}`) and `scanner_auto_save_mode` (`"auto"` \| `"always_confirm"`). |
| `backend/api/settings.py` | New GET/PUT for the two keys above — kept separate from `getScannerConfiguration`/`updateScannerConfiguration` (provider/model/key) rather than folded in, since that endpoint's "Test and save" capability-probe flow is specific to providers and has nothing to do with these fields. |
| `frontend/src/api/client.js` | New `getScannerTuning()`/`updateScannerTuning()` thin wrappers over the new endpoints. |
| `frontend/src/utils/scannerTuning.js` | **New.** Plain `localStorage.getItem`/`setItem` under one JSON key (matches this app's existing convention — see `useTheme.js`'s direct `localStorage` use, no wrapper abstraction elsewhere in this codebase) for the per-device override, plus the resolve-with-precedence function both `DeckCardScanner.jsx` and the new settings UI call. |
| `frontend/src/components/ScannerTuningCard.jsx` | **New, separate sibling card** to `ScannerSettingsCard.jsx` (decided per P4-1 in Review findings — that card is already this app's densest, phone-first settings surface). Preset `<select>`, an Advanced `<details>` section with the 4 raw-value fields (mirroring the existing Advanced-model pattern), a plain-checkbox convention for the two toggles, and an inline caption + text-link reset action for the device/account-override state (P4-2/P4-3/P4-4). |
| `frontend/src/components/DeckCardScanner.jsx` | Module-level constants (`DETECTION_INTERVAL_MS`, `REQUIRED_STABLE_FRAMES`, `STABILITY_TOLERANCE_PROPORTION`, and Phase 3's auto-trigger threshold/pass-count) become values resolved at scanner-open time via `scannerTuning.js`, not hardcoded. The always-on debug block gets gated behind the new diagnostics toggle. |
| `frontend/src/i18n/en.js` | New copy: preset names/descriptions, Advanced field labels, the diagnostics and auto-save toggles. |

## Risks

- **This touches already-shipped, real-device-tested Phase 1 code, not
  just new Phase 3 surface.** Turning `DETECTION_INTERVAL_MS` and friends
  from compile-time constants into a runtime-resolved value is a real
  change to code the plan elsewhere describes as "unchanged" (Path A). The
  Balanced-preset-equals-today's-values decision (Decision 3) keeps
  default *behavior* identical, but the *code path* producing that
  behavior changes — worth a real-device regression pass on Path A
  specifically, not just the new settings UI.
- **Partial-override merge correctness.** A device override that only sets
  one field must not blank out the others — a naive "device override
  replaces the whole config object" implementation would silently reset
  every field the user didn't mean to touch back to a `Fast`-like preset's
  defaults (or `undefined`) the moment any single field is customized
  locally.
- **Garbage values are a real (if bounded) risk, not just an edge case** —
  see the clamping requirement above. Both the account-level PUT and the
  local override write need the same validation, since either can be the
  source of an effective value at runtime.
- **Two related toggles, two different storage homes, on one screen.**
  Diagnostics (per-device) and auto-save mode (per-account) sit next to
  the tuning preset (two-layer) on the same settings section — worth being
  deliberate in the UI about which control is "just this device" and which
  is "everywhere you're logged in," since the tuning preset's own
  per-device override affordance could otherwise make a user assume
  *everything* on the screen works that way.
- **Scope check.** This is the most complex of the three storage options
  considered (a single per-device or single per-account setting would each
  have been simpler to build) — deliberately chosen because neither
  simpler option was actually correct for hardware-dependent values. Worth
  remaining aware that this is added complexity in service of correctness,
  not a default to reach for on future settings without the same
  hardware-dependency reasoning.

## Testing

- `scannerTuning.js`'s resolution function: pure unit tests — device
  override present/absent/partial, account default present/absent,
  fall-through to hardcoded factory values, and that a partial device
  override merges field-by-field rather than replacing the whole config.
- Backend: validation-bounds tests for both new `UserSetting` keys
  (reject out-of-range values) and a round-trip test for each key.
- Manual, real-device: confirm Balanced preset behaves identically to
  today's shipped scanner (the regression check the Risks section above
  calls for); confirm a per-device override on one phone doesn't appear
  when logging into the same account on a second phone; confirm the
  diagnostics toggle actually hides the debug block; confirm an
  auto-save-disabled account always lands in the candidate picker even on
  an otherwise-confident match.

## Build order

18. Backend: the two new `UserSetting` keys, validation bounds, GET/PUT
    endpoints, tested both ways.
19. `scannerTuning.js`: resolution-with-precedence logic and the
    `localStorage` read/write for the device-override layer, unit-tested
    independently of any component.
20. Wire `DeckCardScanner.jsx`'s constants over to resolved values, and gate
    the debug block behind the diagnostics toggle. Real-device regression
    pass on Path A specifically (see Risks) before touching anything else.
21. Settings UI: preset picker + Advanced section + the two independently-
    homed toggles, wired to the endpoints/localStorage from steps 18-19.
22. Real-device test per the Testing section above.

## Review findings — Phase 3 & 4 second pass (multi-persona + OCR-model-expert)

A follow-up seven-lens pass (tag suffix `2` distinguishes these from Phase
3's earlier table) plus the same added OCR/vision-model-domain lens, run
after Phase 4 was written — covering both phases together since Phase 4
now reaches into values Phase 3 defined. A UI-craft pass (`ui-review`
agent) is running separately and will be added as its own table once it
completes, matching how this document has layered review passes before.

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| A2-1 | HIGH | `stabilityTrackerRef` is built via `useRef(createStabilityTracker({...}))` — verified (`DeckCardScanner.jsx:144-147`) this runs synchronously exactly once, at first render, using whatever values are in scope at that instant. If Phase 4's account-level tuning default loads asynchronously (as R2-1 below says it must, to avoid delaying scanner startup), the tracker gets built from the device-override-or-hardcoded fallback *before* the account fetch resolves, and nothing in the plan says to rebuild it once the real value arrives — a user's account-level custom preset could silently not apply on a session that opens before the fetch settles, with no visible sign anything's wrong | New Risks bullet below; build-order step 20 updated |
| R2-1 | HIGH | The new account-tuning GET adds a network round-trip to scanner-open that the plan never says must run in parallel with (not block) the existing camera-permission request and `preloadCardDetection()` — if it blocks, scanner-open gets slower; if it doesn't (the right choice), A2-1's race becomes a real risk unless explicitly handled | New Risks bullet below; build-order step 20 updated |
| M2-1 | MED | Raising "Careful"'s confidence threshold (88% vs. Balanced's 80%) and pass-count (4 vs. 3) doesn't protect against the specific failure mode Phase 3's own Decision 7 names — a confidently-read wrong digit (`052`→`057`). Both knobs filter random per-frame noise; neither helps against a *systematic* misread the engine reads the same wrong way every single pass (a font rendering or lighting pattern that consistently reads as a different digit). "Careful" mode risks reading as more protective against exactly this risk than it actually is — the uniqueness check is the only real protection here, unrelated to which preset is active | New Risks bullet below |
| X2-1 | MED | Validation section covers numeric bounds (dwell/tolerance/confidence/passes) but not enum validation — `preset` and `scanner_auto_save_mode` should be restricted to their known value sets and reject anything else, not just clamp numbers | New Risks bullet below |
| A2-2 | MED | Doesn't state whether `scanner_auto_save_mode` gates both Path A and Path B's auto-save decision, or just one — both already share the `confirmCard` call site, so a single shared check is the natural implementation, but this should be explicit now that there are two call sites, not one | New Risks bullet below |
| S2-1 | MED | `DETECTION_INTERVAL_MS` is read directly inside the tick-loop `useEffect`'s `setInterval(...)`, whose dependency array is `[phase, cameraStatus]` (verified, `DeckCardScanner.jsx:598-602`) — fine today since it's a true constant. Once it's a resolved runtime value, it either needs to join the dependency array (restarting the interval on a tuning change — acceptable) or be read via a ref to avoid that restart; the file table doesn't say which, and guessing wrong risks a stale closure locking in an outdated interval forever | New Risks bullet below |
| Q2-1 | MED | Testing section's auto-save-toggle check doesn't specify testing it against Path A and Path B independently — ties to A2-2 | New Testing bullet |
| Q2-2 | MED | No test specified for the account-tuning-fetch failing outright (vs. "hasn't loaded yet") — should assert the scanner still opens on hardcoded factory defaults rather than blocking or crashing | New Testing bullet |
| Q2-3 | LOW | Phase 3's own real-device test scenarios (zoom-in, misread-collision) were written before presets existed — should be re-run under Fast and Careful once Phase 4 ships, not just Balanced | New Testing bullet |
| M2-2 | LOW | Ties to Phase 3's M-3 (whitelisting can inflate confidence on a bad read) — if that inflation is severe, Careful's 88% may not filter meaningfully more bad reads than Balanced's 80%, since both could sit above an inflated floor. A preset's *felt* difference is itself unvalidated, not just the base threshold | New Risks bullet below |
| B2 | LOW | No schema change (reuses `UserSetting`), but `scanner_tuning`'s JSON in a `Text` column needs defensive parsing (malformed/legacy JSON → fall back to factory defaults), not just write-time validation | New Risks bullet below |
| D2 | — | No migration needed (table already exists), no new env vars | Clean, no finding |
| X2-2 | LOW | File table doesn't restate that the new `settings.py` routes need `Depends(get_current_user)` — this document has flagged this exact omission category before (Phase 2's Security-1, Phase 1's Security-3) | New Risks bullet below |

### New Risks (from the second pass above)

- **Async account-default fetch must not block scanner startup, and must
  not race the synchronous mount-time construction it feeds.** (A2-1,
  R2-1) The account-tuning GET has to run in parallel with the existing
  camera-permission request and `preloadCardDetection()` call — blocking
  on it would slow down opening the scanner. But `stabilityTrackerRef` is
  built via `useRef(createStabilityTracker({...}))`, verified to run
  synchronously exactly once at first render (`DeckCardScanner.jsx:144-147`)
  — if the account fetch is still in flight at that moment, the tracker
  locks in the device-override-or-hardcoded values, and the plan needs to
  say explicitly whether/how it gets rebuilt once the account value
  arrives, or a custom account preset can silently fail to apply on a
  freshly-opened session.
- **Confidence threshold and pass-count don't protect against a systematic
  misread, only a noisy one.** (M2-1, M2-2) "Careful" raising both knobs
  filters out low-confidence or inconsistent reads, but a misread the
  engine produces the same wrong way every pass — consistent lighting, a
  font Tesseract consistently confuses — sustains across passes exactly
  like a correct read would. The uniqueness check remains the only real
  guard against Decision 7's named risk (a confident misread colliding
  with a different missing card), independent of preset; Phase 4's UI
  copy shouldn't imply "Careful" meaningfully reduces that specific risk.
  Compounding this: if character-whitelisting inflates confidence on bad
  reads (Phase 3's M-3), a preset's felt difference is itself unvalidated
  until measured, not just the base 80%/88% numbers.
- **Validate enums, not just numeric ranges.** (X2-1) `preset` and
  `scanner_auto_save_mode` need an explicit allowed-values check, rejecting
  anything outside their known sets — the numeric-bounds validation
  already specified doesn't cover this.
- **State explicitly which call sites `scanner_auto_save_mode` gates.**
  (A2-2) Both Path A and Path B call the same `confirmCard` — the natural
  implementation is one shared check before either path calls it
  programmatically, but this should be said outright now that a second
  call site exists.
- **`DETECTION_INTERVAL_MS` becoming a runtime value needs an explicit
  dependency-array or ref decision.** (S2-1) It's read inside a
  `useEffect` whose deps are currently `[phase, cameraStatus]` — verified
  the interval literal isn't a dependency today because it's a true
  constant; once it isn't, the file table's implementation needs to pick
  one of the two options above rather than leaving it implicit.
- **`scanner_tuning`'s stored JSON needs defensive parsing.** (B2) A
  malformed or legacy-shaped value in the `Text` column should fall back
  to factory defaults, not throw, mirroring the same fail-safe the account-
  fetch-failure case above needs.
- **Restate the auth-dependency requirement on the new routes.** (X2-2)
  Same discipline this document has already applied twice before (Phase 1
  and Phase 2's own Security findings) — the new `settings.py` GET/PUT
  need `Depends(get_current_user)` like every sibling route, stated
  explicitly in the file table, not assumed.

### New Testing (from the second pass above)

- Assert `scanner_auto_save_mode = "always_confirm"` routes to the
  candidate picker from **both** Path A (quad-stability) and Path B
  (Phase 3's zoom-trigger) independently, not just one (Q2-1).
- Assert an account-tuning GET failure (not just "hasn't loaded yet")
  still lets the scanner open on hardcoded factory defaults, rather than
  blocking or crashing (Q2-2).
- Re-run Phase 3's own real-device manual test list under the Fast and
  Careful presets once Phase 4 ships, not just Balanced/default (Q2-3).

## Review findings — Phase 3 & 4, UI-craft pass (`ui-review` agent)

Run against the actual current `DeckCardScanner.jsx` render tree,
`ScannerSettingsCard.jsx`'s full existing layout, and `index.css`'s theme
system — not the plan prose in isolation, matching how Phase 1's own
"Fourth pass" UI review worked.

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| P3-1 | HIGH | The live "N% — 052/198" readout has no layout spec, and competes for screen space with two things that already exist during `hunting`: the floating "Scan now" button and a single one-line hint slot (`liveHint`) below the video. Phase 3's own file table adds a *second* hint string ("try zooming in") with no statement of how the two share that one line | New "UI placement" subsection below: percentage lives in its own badge on the video frame, not the hint slot; the hint slot becomes dynamic (swaps text based on confidence) instead of gaining a second string |
| P3-2 | HIGH | Path A already has an established "getting close" visual language in this exact file (`drawOverlay` ramps the quad outline from dim white to the active theme's brand color as the stability streak builds) — plan never says whether Path B's readout reuses that convention or invents a new one | New "UI placement" subsection: explicitly reuses the same dim-to-accent progression |
| P3-3 | HIGH | Verified: `--color-brand-red` is not fixed red — it's remapped per theme (yellow in `electric`, green in `grass`, blue in `water`). A naive red/yellow/green confidence scheme would collide with the quad-outline's own use of the theme accent color for "about to capture" in at least two themes | New "UI placement" subsection: readout uses the app's fixed, non-theme-swapped `badge-red`/`badge-yellow`/`badge-green` tokens instead of the theme-variable accent |
| P3-4 | MED | Phase 4 (which gates the always-on debug block) is gated *on* Phase 3 — so for the entire window Phase 3 ships alone, the new percentage readout sits directly above its own unstyled twin (the debug block already prints `ocrNumber` and per-word confidences in monospace in the same area) | New Risks bullet: accepted as a temporary, known overlap until Phase 4 lands, not a defect to design around |
| P3-5 | MED | No UI state specified for Path B's `match-image` call actually being in flight — unclear whether the percentage just freezes with no loading feedback while that network call runs | New Risks bullet: Path B transitions `phase` to `'processing'` for the call's duration, reusing Path A's existing spinner state verbatim, not a new one |
| P3-6 | LOW | Risks section (M-2) already warns against copy like "78% sure this is your card," but the file table's exemplar copy is bare "N%" with no label | `en.js` file-table row updated: label pairs the number with "read quality," not "match confidence" |
| P4-1 | HIGH | `ScannerSettingsCard.jsx` is already this app's densest, phone-first settings card (provider/model/key/test/admin sections) — Phase 4 proposed adding a 3-option preset picker, a 4-field Advanced section, a device/account indicator, and two more toggles to "the same screen," which is too much for a card this size already | New Decision below: separate sibling card, not appended to `ScannerSettingsCard.jsx` |
| P4-2 | MED | The "this device" indicator and "Reset to account default" action have zero precedent anywhere in this codebase (verified: no device/session UI, no "synced" language anywhere) — Decision 2's "mirrors an existing pattern" claim doesn't cover this specific piece | New Decision below: a plain inline caption + text-link reset action, not a new badge/icon system — deliberately the smallest possible net-new UI, since nothing existing can be reused here |
| P4-3 | MED | Every boolean control in this card today is a plain `<input type="checkbox">` with an inline label (verified: zero `role="switch"` anywhere in the frontend) — plan calls the two new booleans "toggles" without confirming which convention they use | New Decision below: both new booleans use the existing checkbox convention, not a new switch component |
| P4-4 | LOW | Preset picker's control type is unspecified — this card's only existing choice-of-N pattern is a `<select>` (provider/model), which may undersell presets as "the primary control" (Decision 2), but a new segmented-tab control would itself be a new pattern | New Decision below: reuses the existing `<select>` convention — consistency with this card over novelty, until real usage shows presets need more visual weight |

### UI placement (Phase 3, resolves P3-1/P3-2/P3-3)

- The percentage lives in its own small badge/pill overlaid on the video
  frame (near the existing overlay canvas), not inside the single-line
  hint slot below it — that slot stays exactly what it is today.
- **Added per Decision 8**: the same badge grows a second line the moment
  the OCR-read number uniquely matches a missing card — e.g. "72% —
  025/198" on the first line, the bare name "Pikachu" on a second,
  smaller line below it (no "looks like" or other hedging phrase — the
  smaller/secondary styling is what signals "preview, not confirmed,"
  the wording doesn't need to). Absent until a unique match exists (no
  placeholder text, no layout shift from a guess); this is a preview,
  not a claim of identity, so it should read visually secondary to the
  percentage, not equal weight with it.
- The hint slot itself becomes **dynamic, not additive**: it shows the
  existing "Hold one card steady…" text during ordinary positioning, and
  swaps (not stacks) to "Low confidence — try zooming in on the number"
  specifically while Path B is tracking a sub-threshold reading. One
  string in the slot at a time, matching its existing one-line design.
- The badge's color ramps using the **same dim-white-to-theme-accent
  progression** `drawOverlay` already uses for the stability outline, for
  visual consistency between "Path A is about to capture" and "Path B is
  about to attempt" — but using this app's **fixed** `badge-red`/
  `badge-yellow`/`badge-green` tokens for the confidence-tier coloring
  itself, not the theme-variable brand accent, since that accent already
  means something else (and is a different color per theme) via the
  existing outline.
- Path B's `match-image` call transitions `phase` to `'processing'` for
  its duration, reusing Path A's existing spinner/"Identifying card…"
  state verbatim — no new loading UI (resolves P3-5).
- The always-on debug block sitting above this new readout until Phase 4
  gates it is accepted as a known, temporary overlap, not something Phase
  3 needs to solve on its own (resolves P3-4).

### New Decisions (Phase 4, resolves P4-1/P4-2/P4-3/P4-4)

1. **Separate sibling card, not appended to `ScannerSettingsCard.jsx`.**
   A new `ScannerTuningCard.jsx` renders below the existing card on the
   same Settings page — the existing card is already this app's densest,
   and Phase 4's own content (preset picker, 4-field Advanced section,
   device/account indicator, two toggles) is too much to add to it without
   a layout decision, which "New 'Scanner tuning' section" in the original
   file table didn't actually make.
2. **The device/account-override indicator is a plain inline caption and
   text-link reset action** ("Using your account default" /
   "Custom on this device — Reset"), not a new badge or icon system.
   Deliberately the smallest possible net-new UI, since nothing in this
   codebase can be reused for this specific distinction (verified: no
   existing device/session-management UI anywhere).
3. **Both new booleans use the existing plain-checkbox convention**
   (`<input type="checkbox">` with an inline label, matching the
   custom-model and degraded-acknowledge checkboxes already in
   `ScannerSettingsCard.jsx`), not a new switch/toggle component — this
   app has none today.
4. **The preset picker reuses the existing `<select>` convention**
   (matching the provider/model dropdowns), not a new segmented-tab
   control. Consistency with this card's established pattern wins over
   giving presets more visual prominence, at least until real usage shows
   a dropdown undersells them.
