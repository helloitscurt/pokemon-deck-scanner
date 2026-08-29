# Live continuous-stream card scanner (deck-tracking scanner)

This document covers two phases. **Phase 1** replaces the deck-tracking
scanner's point-and-shoot flow with a live camera stream that auto-detects,
auto-captures, and (when confident) auto-saves a card — the core ask, and a
complete, shippable feature on its own. **Phase 2** is an optional follow-up,
gated on Phase 1 being live: recognize the card's text client-side (OCR)
instead of always paying for a vision-API call, falling back to the paid
call only for cards OCR can't confidently resolve. Phase 2 should not block
or delay Phase 1.

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
