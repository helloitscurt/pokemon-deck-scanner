# Scanner: pause toggle, outline-tracking-speed slider, tap-for-details

## Context

Three items from `docs/plans/scanner-ux-todos.md`/`live-card-scanner.md`,
requested together: item 8 (tap a recent-scan thumbnail for card details +
the actual scan photo), item 10 (pause/stop continuous scanning so you can
line up a shot first), and Phase 4 (originally "configurable
detection/OCR tuning," redefined below to just the outline's tracking
speed).

The user asked for 10 and Phase 4 specifically as an **in-scanner** gear
icon → popup, with 10 as a toggle and Phase 4 as a slider. This is a
lighter-weight surface than Phase 4's original design doc (which specified
a full Settings-page card, backend `UserSetting` sync, a two-layer
account+device precedence system, plus two unrelated toggles for
diagnostics/auto-save) — and, per direct correction, a different *target*
too: the slider is **not** the original doc's 4-field capture-trigger
bundle (dwell/tolerance/confidence/passes). It controls
`OVERLAY_SMOOTHING_ALPHA` — the exponential-smoothing constant tuned
earlier this session that governs how fast the drawn detection outline
(the four-corner highlight rectangle) tracks a moving card, as opposed to
lagging smoothly behind it. Stored device-locally only (`localStorage`,
no backend/account layer) — a deliberate simplification from the original
Phase 4 doc, flagged here so it's a conscious choice, not a missed
requirement.

All three items live entirely in `frontend/src/components/DeckCardScanner.jsx`
plus one small new util module. No backend changes.

## Verified current state (exact locations)

- `OVERLAY_SMOOTHING_ALPHA = 0.42` (line 122) — the one and only real
  usage site is line 1344, inside Path A's tick loop:
  `lerpQuad(smoothedQuadRef.current, quad, OVERLAY_SMOOTHING_ALPHA)`.
  Nothing else reads it — no ref-recreation concern like a factory-baked
  config would have (unlike, say, `stabilityTrackerRef`), so a live value
  read each tick is all that's needed.
- Path A tick loop: `useEffect` at 1285-1390, deps `[phase, cameraStatus]`.
  Path B tick loop: 1408-1507, same deps. Capture submission itself
  (`submitCapture` call inside Path A, `attemptZoomMatch`'s auto-save
  inside Path B) has no phase gate today — this is where the pause check
  goes.
- The `isOpen` reset effect (668-690) already resets every other
  transient hunting-phase ref/state on a fresh open (explicitly leaves
  `recentScans`/`activeJobs` alone) — pause state joins the reset list,
  the smoothing-speed index does not (it's a device preference, not
  session state).
- Header row (1576-1586): title + a `w-9 h-9` circular close button,
  unconditional on phase. Gear button goes here, matching that button's
  exact size/background/style.
- `addRecentScan` (794-835) already stores the full `candidate` object
  on each entry (`candidate,` at line 801) — item 8's `CardModal` can use
  it directly, no new plumbing needed for the card data itself.
- `confirmCard` (877-917) is called from 4 sites: the Path A auto-save
  (1166, has `cropCanvas` in scope), Path B's zoom-match auto-save (1215,
  only has a number-only fragment crop — not a useful "photo of the
  card"), the ambiguous-picker's manual tap (1897, no raw canvas in scope
  at all by then), and quick-add (933, no new capture happened). Only the
  first of these can honestly provide "the actual photo used to scan it";
  the other three fall back to catalog art (`scan.image`) as designed.

## Item 10: Pause/resume continuous scanning

**Semantics (this is the load-bearing decision):** "paused" suppresses
the *auto-capture trigger* only — detection keeps running and the overlay
keeps drawing live, so the user can still see positioning feedback while
lining a card up (that's the whole point of the request). The existing
manual `handleScanNow` button stays active and unaffected while paused —
it's the intended way to fire a capture on demand once the shot looks
right.

**Implementation:**
- `const [scanningPaused, setScanningPaused] = useState(false)` — reset to
  `false` in the `isOpen` effect (668-690), NOT persisted to
  `localStorage` (momentary/session behavior, not a lasting device
  preference — resets to today's default behavior every time the scanner
  reopens, so nothing changes for anyone who never touches the toggle).
- `const scanningPausedRef = useRef(scanningPaused)` + a `useEffect`
  syncing it, mirroring the existing `phaseRef` pattern in this same file
  — needed because the tick loops read it inside a `setInterval` closure
  that must NOT be torn down/recreated just to flip a boolean (that would
  needlessly reset `tickInFlightRef`/timing).
- Guard exactly two call sites with `!scanningPausedRef.current`: Path
  A's `submitCapture(...)` call (currently unconditional once
  `readyToCapture && quad && !isAwaitingRemoval`), and Path B's
  `attemptZoomMatch(...)` auto-trigger call. Everything else (overlay
  drawing, quality/OCR reads, the manual Scan Now button) is untouched.
- Toggle UI: mirror `Settings.jsx`'s pill-switch `Toggle` (button-based,
  `w-11 h-6` track, `translate-x-5` thumb) inlined locally in
  `DeckCardScanner.jsx` rather than extracting a new shared component for
  a single use site.

## Phase 4 (redefined here): outline-tracking speed, a 5-position slider

**Not** the original doc's capture-trigger tuning bundle — per direct
correction, this slider controls only `OVERLAY_SMOOTHING_ALPHA`, i.e. how
fast the drawn four-corner outline moves to follow the raw detected quad
each tick (higher = tracks the raw quad more closely, more responsive but
more jittery; lower = lags further behind, smoother but slower to settle
onto a repositioned card). Nothing about the capture trigger itself
(stable-hold frame count, tolerance, confidence thresholds) changes.

**5 values, current shipped value (0.42) as the middle:**
```js
export const OVERLAY_SMOOTHING_ALPHA_VALUES = [0.30, 0.36, 0.42, 0.48, 0.54]
export const DEFAULT_SMOOTHING_SPEED_INDEX = 2 // 0.42, today's shipped value
```
Step of 0.06 between each — this deliberately extends a little past both
ends of what was already real-device tested this session (0.35 read as
"too slow," 0.5 as "too jumpy," 0.42 as the settled middle), so the two
extremes (0.30, 0.54) are genuinely further in each direction than
anything tried so far, giving the slider real range in both directions
rather than five values clustered around 0.42.

**New file `frontend/src/utils/outlineSmoothing.js`** (mirrors
`useTheme.js`'s plain-`localStorage`-no-wrapper convention, key
`'scannerSmoothingSpeedIndex'`): the array/default above, plus
`getStoredSmoothingSpeedIndex()` (validates the stored value is an
integer 0-4, else falls back to the default) and
`setStoredSmoothingSpeedIndex(index)`. Include
`outlineSmoothing.test.js` (array shape, storage round-trip, invalid/
out-of-range stored value falls back to the default), matching this
codebase's convention of unit-testing every new util module
(`imageSharpness.test.js`, `quadStability.test.js`, etc.).

**Wiring into `DeckCardScanner.jsx`** — much simpler than a config-object
swap, since this is one plain number read fresh each tick, not a
factory-baked object like `stabilityTrackerRef`:
- `const [smoothingSpeedIndex, setSmoothingSpeedIndex] = useState(() => getStoredSmoothingSpeedIndex())`
  — lazy-init from storage, NOT reset by the `isOpen` effect (device
  preference, survives close/reopen, same as the tuning preset was
  going to be).
- `const smoothingSpeedIndexRef = useRef(smoothingSpeedIndex)` + a
  `useEffect` syncing it, same ref-mirror pattern as `scanningPausedRef`
  — avoids tearing down/recreating Path A's tick interval just to change
  a number.
- Replace the one real usage site (line 1344) with
  `OVERLAY_SMOOTHING_ALPHA_VALUES[smoothingSpeedIndexRef.current]` in
  place of the constant.
- Slider `onChange`: `setSmoothingSpeedIndex(newIndex)` and
  `setStoredSmoothingSpeedIndex(newIndex)` — no stability-tracker
  recreation or streak reset needed (unlike the original 4-field design),
  since this value never feeds the capture-trigger logic at all, only how
  the overlay is drawn.
- Slider UI: native `<input type="range" min="0" max="4" step="1">`, with
  "Smoother" / "Faster" captions at the two ends rather than 5 named
  labels (this is a continuous physical feel, not discrete named modes
  like Fast/Balanced/Careful). No range-input precedent exists anywhere
  in this app to copy — `accent-brand-red` alone (the only existing
  `accent-*` use in this codebase is on a checkbox, `CardItem.jsx:248`)
  only recolors the native thumb/track fill; it sets nothing for size or
  contrast against a dark, blurred camera backdrop. Needs explicit
  styling, not just that one property: a track height/visibility that
  reads clearly against `rgba(0,0,0,0.95)` (the modal's own backdrop
  color), and a thumb sized to match this file's existing 36px circular
  touch targets (the "+"/"-" stepper buttons) — a browser-default range
  thumb is smaller than that and would be the one undersized touch target
  on an otherwise consistent screen.

## Gear icon + settings modal (shared by 10 and the slider)

- Add `Settings` and `Info` (the gear trigger and item 8's thumbnail
  affordance icon, see below) to the existing lucide-react import line
  (`AlertTriangle, Camera, Check, Loader2, Minus, Plus, X`).
- In the header row (1576-1586), wrap a new gear `button` (identical
  `w-9 h-9 rounded-full` / `rgba(255,255,255,0.08)` styling to the close
  button, swapping `X` for `Settings`) together with the existing close
  button in a `flex items-center gap-2.5` container on the right side, so
  both stay right-aligned. The two buttons are distinguished only by icon
  glyph at a small size (both `w-9 h-9`, same fill) — worth a deliberate
  on-device check that `gap-2.5` (slightly more than the default `gap-2`)
  gives enough separation for a thumb reaching across the header mid-scan,
  not just eyeballing it on a desktop screenshot.
- `const [showSettings, setShowSettings] = useState(false)` (also reset
  to `false` in the `isOpen` effect, for the same reason as
  `scanningPaused`).
- Reuse `ui/Modal.jsx` (`size="sm"`) for the popup content — no lightweight
  anchored-popover primitive exists anywhere in this app to justify
  building a new one; `Modal` already gives portal rendering and
  Escape/backdrop-close for free.
  **Stacking, verified not just assumed:** `Modal`'s backdrop defaults to
  `overlayClassName="z-50"` (`ui/Modal.jsx:30`), which is *below* the
  scanner's own `z-[200]` (`DeckCardScanner.jsx:1573`) — used as-is, the
  settings popup would paint and hit-test behind the live scanner and be
  completely unusable. Worse on mobile specifically: `Modal` delegates to
  `ui/Sheet.jsx` there, which **hardcodes** `z-50` directly in its
  className with no prop to override it at all (`ui/Sheet.jsx:36,45`) —
  so overriding `overlayClassName` alone fixes desktop but not phones,
  the primary way this scanner is actually used. Pass **both**
  `mobileSheet={false}` (forces the centered `DesktopModal` variant on
  every viewport, which *does* thread `overlayClassName` through) **and**
  `overlayClassName="z-[300]"` — reusing this file's own existing
  precedent for "needs to render above the scanner" (the error-preview
  lightbox already uses `z-[300]` for the same reason, line ~1939). The
  two can never be open simultaneously (the lightbox covers the header
  entirely while open, so the gear button isn't reachable then), so
  reusing the same tier rather than inventing a new one is safe.
- New i18n keys: `decks.scan.settingsTitle`, `decks.scan.pauseScanning`,
  `decks.scan.pauseScanningHint`, `decks.scan.outlineTrackingSpeed`,
  `decks.scan.smootherLabel`, `decks.scan.fasterLabel`.

## Item 8: tap a recent-scan thumbnail for details + the real captured photo

- **Discoverability — this file has real history here, worth heeding, not
  just a generic UI nitpick.** `RecentScanThumb`'s own comment
  (`DeckCardScanner.jsx:255-271`) records that its image used to double
  as the quick-add tap target, and this session deliberately moved that
  to the side stepper instead, specifically because a bare/overlapping
  tap affordance on this exact thumbnail was already a documented
  problem ("a corner bubble was easy to miss as a real tap target"). A
  bare image with zero visual cue, sitting directly beside a bold colored
  stepper that already reads as "the interactive part," risks being
  missed the same way for this new, different action (view details).
  Add a small, unobtrusive affordance — reuse this same thumbnail's
  existing small-corner-badge visual language (the `pathLabel` badge
  already sits at `absolute bottom-1 left-1 right-1`, see the component
  above) rather than inventing a new visual pattern: a small semi-
  transparent icon (e.g. lucide `Info`, ~12px) in the image's
  top-left corner signals "there's more here" without competing with the
  stepper or the existing bottom path-label badge.
- `RecentScanThumb`'s image wrapper becomes a `<button type="button">`
  (mirrors the existing failed-capture-thumbnail button pattern already
  in this file) with the small info-icon affordance above and a new
  `aria-label={t('decks.scan.viewScanDetails')}` (+ that new i18n key),
  opening the detail view on tap.
- Thread a `capturedImage` value through the ONE call chain that can
  honestly provide it — the confident-match branch of
  `captureAndRecognize` that calls `confirmCard` at line 1166, which
  covers **both** the unattended continuous auto-trigger and a manual
  "Scan now" tap (`handleScanNow`) that resolves confidently, since both
  funnel through the exact same code path; "Path A auto-save" in this
  doc's earlier notes means that call site specifically, not literally
  only unattended captures. That site passes
  `cropCanvas.toDataURL('image/jpeg', 0.7)` as a new trailing argument
  (same encoding `errorCardImage` already uses at line 1182, for
  consistency) — the other 3 `confirmCard` call sites (quick-add,
  zoom-match, ambiguous-pick) pass nothing, defaulting to `null`. Since
  `capturedImage` is appended as the function's 7th positional param
  (after `quickAddTarget`), the line-1166 call site needs its
  `quickAddTarget` slot filled explicitly with `null` to reach it —
  worth calling out here so the actual edit doesn't miscount positional
  args: `confirmCard(topCandidate, topCandidate.id || 'auto', true, data.trace_id, data._identity_decision, null, cropCanvas.toDataURL('image/jpeg', 0.7))`.
- `confirmCard`'s new `capturedImage = null` param threads into
  `addRecentScan`/`bumpRecentScanQuantity`, stored on the entry as
  `scan.capturedImage`. Per the decision already recorded in
  `scanner-ux-todos.md` item 8, this lives and dies with the entry itself
  — no separate storage/cleanup path, so it's already correctly discarded
  whenever `recentScans` filters the entry out (LRU eviction or a
  full "-" removal), and correctly persists across the scanner closing/
  reopening since it rides on the same array item 1 already decided
  should survive that.
- New state in the parent: `const [detailScan, setDetailScan] = useState(null)`,
  set by the thumbnail's `onClick`, cleared by `CardModal`'s `onClose`
  (mirrors `DeckDetail.jsx`'s own `selectedCard` pattern exactly). Render:
  ```jsx
  {detailScan && (
    <CardModal
      card={detailScan.candidate}
      image={detailScan.capturedImage || detailScan.image}
      onClose={() => setDetailScan(null)}
      defaultLang={detailScan.candidate.lang || 'en'}
      initialTab="overview"
      readOnly
    />
  )}
  ```
- Known, deliberate scope limit (documented in code + PR, not silently
  dropped): a Path B zoom-match auto-save, or a manual pick from the
  ambiguous list, shows catalog art in the detail view rather than the
  real capture — those two paths never have a usable full-card crop in
  scope at confirm time.

## Repo housekeeping

Copy this plan document itself into `docs/plans/scanner-pause-speed-details.md`
as part of the implementation commit — this project keeps its design docs
in-repo (see the existing `docs/plans/*.md` files), and this plan should
join them rather than staying only in the local, ephemeral plan-mode
location it was drafted in.

## Files touched

- `frontend/src/components/DeckCardScanner.jsx` — all of the above,
  including a new `import { CardModal } from './CardItem'` and
  `import Modal from './ui/Modal'` for item 8 and the settings popup
  respectively.
- `frontend/src/utils/outlineSmoothing.js` (new) + `outlineSmoothing.test.js` (new).
- `frontend/src/i18n/en.js` — the 7 new keys listed above.
- `frontend/src/components/DeckCardScanner.test.jsx` — new coverage (see
  below), including a new `vi.mock('./CardItem', ...)` stub that doesn't
  exist in this test file today.

## Test plan

- `outlineSmoothing.test.js`: the 5-value array shape, storage round-trip,
  an invalid/out-of-range stored index falls back to index 2 (0.42).
- `DeckCardScanner.test.jsx` additions:
  - Pause toggle suppresses an otherwise-ready auto-capture (Path A) but
    manual Scan Now still fires while paused; toggling back off resumes
    auto-capture on the next stable hold. Also cover the edge case
    explicitly (so it isn't mistaken for a bug during manual testing):
    un-pausing a card that was *already* held stable through the full
    streak while paused captures immediately on the next tick — pausing
    doesn't touch `stabilityTrackerRef`'s streak count, only whether a
    ready streak is allowed to actually submit.
  - Moving the outline-speed slider changes the drawn outline's position.
    `lerpQuad` itself isn't mockable (a same-file, non-exported helper,
    not an import `vi.mock` can intercept) — assert on the canvas mock's
    already-spied `moveTo`/`lineTo` call arguments instead (see
    `stubMediaAndCanvas`'s `context2d`), comparing the drawn corner
    coordinates across two ticks under the default index (2, alpha 0.42)
    against the same two ticks under an extreme index (e.g. 4, alpha
    0.54) — the lerped position differs predictably between the two per
    `lerpQuad`'s own formula, which is what actually proves the slider
    took effect rather than just asserting the state variable changed.
  - Tapping a recent-scan thumbnail opens `CardModal` with the captured
    image for an auto-saved card, and with catalog art for a manual
    ambiguous-list pick. **Checked, not assumed:** `DeckDetail.test.jsx`
    doesn't reference `selectedCard`/`CardModal` at all — it never
    exercises that tap-for-details path, so there's no existing mock
    pattern to copy. This test needs its own new
    `vi.mock('./CardItem', () => ({ CardModal: (props) => ... }))`
    stub (rendering just enough — e.g. a `data-testid` div echoing the
    `image`/`card` props it received — to assert on, without pulling in
    `CardModal`'s own real rendering: tabs, price data fetching, etc.).
    Path note: `DeckCardScanner.test.jsx` lives in the same directory as
    `CardItem.jsx` (`frontend/src/components/`), unlike `DeckDetail.jsx`
    (in `pages/`) — the mock target is `vi.mock('./CardItem', ...)`, not
    `'../components/CardItem'`.
  - Settings modal: gear button opens it, contains both controls, closes
    via `Modal`'s existing close affordances.
- Full existing suite (`DeckCardScanner.test.jsx` + whole frontend) must
  stay green — run via the ephemeral `node:20` container approach used
  earlier this session (no local Node available in this environment).

## Verification

1. `docker run --rm -v "$(pwd)/frontend":/app -w /app node:20 sh -c "npm ci && npx vitest run"` —
   full suite green, including new tests above.
2. Manual/mutation-style sanity: temporarily force `scanningPausedRef.current`
   to always read `true` and confirm the new pause test goes red, then
   restore and confirm green (same standard applied to this session's
   earlier concurrent-capture fix).
3. Rebuild + restart the `frontend` container
   (`docker compose build frontend && docker compose up -d frontend`) so
   it's checkable on a real phone via the existing Cloudflare tunnel.

## Review findings (multi-persona-review + ui-review, applied to this plan pre-implementation)

DBA and DevOps came back clean (no schema, no env vars, no CI/deploy
changes — frontend-only). SRE's one note is a confirmed strength, not a
gap: pausing resets every time the scanner reopens rather than
persisting, so there's no way to end up with a silently-forgotten-paused
scanner haunting a later, unrelated session. Security is clean — no
backend touched, no data leaves the device; `capturedImage` lives only in
in-memory component state.

| Tag | Sev | Finding | Addressed in |
|---|---|---|---|
| A/UI-1 | HIGH | `Modal` defaults to `z-50`, below the scanner's own `z-[200]`; `Sheet` (Modal's mobile path) hardcodes `z-50` with no override prop at all — settings popup would be invisible/unusable, worst on mobile specifically | Gear icon + settings modal section: `mobileSheet={false}` + `overlayClassName="z-[300]"` |
| UI-2 | HIGH | Bare-image tap target for item 8 risks the same discoverability failure this exact file already documented and moved away from once (image-as-quick-add-button, replaced by the side stepper) | Item 8 section: small corner info-icon affordance, reusing the thumbnail's existing badge visual language |
| Q-1 | MED | Slider test as originally described ("assert `lerpQuad`'s call") isn't feasible — `lerpQuad` is a same-file, non-exported helper `vi.mock` can't intercept | Test plan: assert on the canvas mock's `moveTo`/`lineTo` call arguments instead |
| Q-2 | MED | Test plan assumed `DeckDetail.test.jsx` already mocks `CardModal` to mirror — checked directly, it doesn't reference `CardModal`/`selectedCard` at all | Test plan: new `vi.mock('./CardItem', ...)` stub, with the correct relative path for this test file's own location |
| UI-3 | MED | `accent-brand-red` alone (recolors fill only) isn't enough for a slider to read as designed against a dark camera backdrop, with no range-input precedent anywhere in this app to fall back on | Phase 4 slider-UI bullet: explicit track/thumb sizing matching the existing 36px touch targets |
| S-1 | LOW | Leftover "the tuning preset" phrasing from before the mid-planning correction (slider target changed from a 4-field bundle to just the smoothing alpha) | Fixed in "Verified current state" |
| S-2 | LOW | `capturedImage`'s new trailing param on `confirmCard` needs the line-1166 call site's `quickAddTarget` slot filled explicitly with `null` to reach it — easy to miscount | Item 8 section: exact call-site rewrite spelled out |
| M-1 | LOW | "Path A auto-save" undersold captured-image scope — a confidently-resolved manual Scan Now tap goes through the identical code path | Item 8 section: clarified explicitly |
| M-2 | LOW | Un-pausing a card already held stable through the full streak would capture immediately (pause never touches `stabilityTrackerRef`'s streak count) — could read as a bug during manual testing if not called out as intended | Test plan: added as an explicit, expected test case |
| UI-4 | LOW | Gear + close buttons are distinguished only by icon glyph at small size | Gear icon section: `gap-2.5` instead of the default `gap-2`, flagged for an on-device spacing check |
