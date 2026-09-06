# Continuous, non-blocking live scanning

Changes [DeckCardScanner.jsx](../../frontend/src/components/DeckCardScanner.jsx)
from "detect → hold steady → freeze → send → wait → show result → resume"
(one card at a time, blocking end to end) to continuous capture: the camera
never stops, several cards can be mid-recognition at once, and a
captured-but-unsent card queues client-side until a slot is free.

Design doc only — no implementation yet.

## Scope

- **Phase 1** (below): confident auto-saves become continuous and
  non-blocking.
- **Phase 2** (deferred, not scoped in detail): ambiguous matches and hard
  failures keep today's full-screen blocking picker/banner. Revisit only
  after Phase 1 has real usage behind it.

## Current behavior

- `phase` is a single scalar: `hunting | processing | ambiguous | success |
  error | cameraDenied`. `result`, `checkmarkStatus`, `checkmarkMeta`,
  `confirmingKey`, and `error` all assume one card is being handled at a
  time.
- The 90ms detection tick loop, and Phase 3's throttled number-only loop
  (Path B), both run only `if (phase === 'hunting' && cameraStatus ===
  'streaming')`.
- `captureAndRecognize` → `beginProcessing()` sets `phase` to
  `'processing'` and shows a full-screen `bg-black/60` spinner for the
  duration of the network round-trip (observed up to 89s+ under load).
- On success, `confirmCard` → `enterSuccessCooldown` sets `phase` to
  `'success'`: a counted save freezes the video behind a centered
  checkmark for `CHECKMARK_DURATION_MS` (900ms); a warning
  (not-in-deck/already-complete) keeps the video live and floats a
  dismissible toast for `WARNING_DURATION_MS` (4s). Either way `phase`
  stays off `'hunting'`, so detection stays paused.
- `awaitingCardRemovalRef` is a single ref tracking the one quad a capture
  was just attempted against, to stop the same still-sitting card from
  being redundantly re-captured once hunting resumes.
- An ambiguous match takes over the full screen with a candidate list
  (`phase === 'ambiguous'`) until the user picks one or taps "Scan
  another."

## Phase 1: continuous capture for confident auto-saves

### State model

- `phase` narrows to four values: `hunting` (ambient state, whether or not
  jobs are in flight), `ambiguous`, `error`, `cameraDenied`.
- New `activeJobs` array, one entry per card currently being handled:
  `{ id, quad, status: 'processing' | 'success' | 'warning', cardMeta }`.
- Processing and success/warning for a confident capture move out of
  `phase` entirely and into `activeJobs`.
- The tick loop's gate changes from "is phase hunting" to "is the screen
  in a blocking mode" (`ambiguous`/`error`/`cameraDenied` only) —
  `activeJobs` having entries no longer pauses detection.

### Concurrency and capture queue

- New `MAX_CONCURRENT_JOBS` constant caps in-flight recognize/match
  requests. Value needs real-device tuning, same as every other threshold
  in this file.
- Capture (cropping the held card to a canvas) still fires immediately on
  `readyToCapture`, uncapped. Sending is what's gated: if `activeJobs.
  length >= MAX_CONCURRENT_JOBS`, the crop goes into a FIFO `pendingQueue`
  and is dequeued into `captureAndRecognize` the moment a slot frees up.
- `awaitingCardRemovalRef` generalizes from one ref to a list — one
  "don't recapture this region yet" entry per in-flight or just-resolved
  job, each cleared independently via the same `quadsAreStable` check used
  today.

### Non-blocking indicators

- Replace the full-screen spinner with a small chip showing an in-flight
  count ("2 scanning…"). Placement: a slim strip under the top bar — the
  four corners are already used (live-confidence badge top-left,
  recent-scans stack bottom-right, "Scan now" bottom-center).
- Drop the checkmark overlay for a counted save; the recent-scans stack's
  new thumbnail sliding in is the confirmation.
- Warning toasts key per-job (a Map, not a single `checkmarkStatus`/
  `checkmarkMeta` pair) so two concurrent warnings don't overwrite each
  other. Otherwise unchanged — already floats over a live, unfrozen feed.

### Concurrent confirms

- `confirmingKey` becomes a `Set`, not a single value — two auto-saves, or
  an auto-save and a quick-add tap, can now genuinely overlap.
- Quick-add's disabled check (`quickAddDisabled = phase !== 'hunting' ||
  confirmingKey != null`) updates to check the set.

### Unchanged

- Path B: already gated on `phase === 'hunting'`, which stays `'hunting'`
  throughout continuous capture — no change needed.
- Ambiguous candidate list, error banner, camera-denied manual fallback:
  untouched, still full-screen, per the Phase 1/2 scope split.
- Quick-add (item 3) and the recognition-path badge (item 5): already
  per-entry, not off shared scalar state — no changes beyond the
  `confirmingKey` generalization above.

### Testing impact

`DeckCardScanner.test.jsx`'s current approach (`advanceTicks` driving one
`phase` transition, asserting a single checkmark) assumes one thing
happens at a time. A meaningful fraction of the existing 43 tests need
rewriting against `activeJobs` array state instead of a scalar `phase` —
a parallel-sized effort to the implementation itself, not a follow-on
cleanup pass.

## Phase 2 (deferred): non-blocking ambiguous/error handling

An in-memory "needs review" queue for the live scanner, surfaced as a
badge/drawer instead of a takeover screen — not the DB-backed
`ScanJob`/`ScanJobItem` model the batch scanner uses (this is a live
single session; nothing here needs to survive closing the scanner).

## Risks

1. Indicator placement has no free corner left on screen.
2. `MAX_CONCURRENT_JOBS` is unvalidated — too high risks burning paid-API
   quota fast on a back-to-back queue; too low barely improves throughput.
3. Multi-region `awaitingCardRemovalRef` tracking is real complexity, and
   overlaps with [item 4](scanner-ux-todos.md)'s multi-quad detection need
   — worth building once if both land in the same timeframe.
4. Test-suite rewrite is comparable in size to the feature work itself.
5. Dropping the checkmark in favor of the recent-scans thumbnail as the
   only success feedback is unvalidated on a real device.

## Next step

Prototype the state-model shift (`activeJobs`, concurrency cap, queue)
against the existing full-screen spinner before building the new
indicator UI — validates whether detection and multi-region removal-
tracking hold up correctly with jobs in flight before spending effort on
UI polish or the test rewrite.

---

## Reasoning

**Why Phase 1 excludes ambiguous/error handling:** confident auto-saves are
the common case and the only case the original request described.
Ambiguous matches need a human decision, which can't stay a full-screen
takeover in a continuous flow without contradicting "never halted" — the
only non-blocking shape for that is a review queue, which is roughly as
much work as the batch scanner's existing `ScanJob`/`ScanJobItem` system
(see [scan_queue.py](../../backend/services/scan_queue.py) and
[ScanQueue.jsx](../../frontend/src/pages/ScanQueue.jsx): a job containing
many items, each independently `pending → processing → done/failed` plus a
separate `resolved` flag, polled via react-query every 3s while anything's
active). Building that before knowing how often ambiguous results actually
occur in this flow risks solving a problem that turns out to be rare.

**Why `activeJobs` instead of extending `phase`:** `phase` as a scalar is
the root cause of "one card at a time" — any fix that keeps a single
value to represent "what's happening" reproduces the same ceiling. An
array is the minimum structure that lets N cards be independently
mid-recognition.

**Why `confirmingKey` and `awaitingCardRemovalRef` both need to become
collections:** this is the same fix already applied once in this file —
`collapsingScanKeys` replaced a single `collapsingScanKey` after a real
bug where a second stack overflow cancelled the first's pending removal
timer. Concurrent jobs create the identical class of problem in two more
places.

**Why the checkmark can be dropped instead of adapted per-job:** once the
video is never frozen, a checkmark has nothing to be read against — the
recent-scans stack (item 2) already renders a new thumbnail the instant a
card saves, which is the same information delivered by a mechanism that
already exists, rather than a new one built to survive concurrency.
