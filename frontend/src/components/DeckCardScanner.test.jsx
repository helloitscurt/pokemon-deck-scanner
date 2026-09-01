// @vitest-environment jsdom
//
// Establishes component-level state-machine testing for this codebase —
// see docs/plans/live-card-scanner.md's Testing section: there was no
// existing precedent for testing a rendered, stateful component (no
// @testing-library/react before this). Mocks cardDetection.js (canned
// detection results, no real OpenCV/WASM) and recognizeCard, and drives
// the detection loop with fake timers to assert the actual state
// transitions rather than just the pure quadStability.js comparator.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DeckCardScanner from './DeckCardScanner'
import { matchDeckImage, recognizeCard } from '../api/client'
import { detectCardQuad, extractCard, preloadCardDetection } from '../utils/cardDetection'
import { lastOcrRawText, lastOcrWords, recognizeCardText, recognizeNumberRegion } from '../utils/cardOcr'

vi.mock('../api/client', () => ({
  recognizeCard: vi.fn(),
  matchDeckImage: vi.fn(),
}))

vi.mock('../utils/cardDetection', () => ({
  detectCardQuad: vi.fn(),
  extractCard: vi.fn(),
  preloadCardDetection: vi.fn(),
  detectionStatus: { state: 'ready', error: null },
}))

vi.mock('../utils/cardOcr', () => ({
  recognizeCardText: vi.fn(),
  recognizeNumberRegion: vi.fn(),
  preloadCardOcr: vi.fn(),
  lastOcrRawText: { value: '' },
  lastOcrWords: { value: [] },
}))

let mockCameraStatus = 'streaming'
// A stable ref object, reused across renders — matches the real
// useCameraStream, whose videoRef comes from an actual useRef() and never
// changes identity. A fresh {current: null} object per call would make
// React detach the rendered <video> from whichever ref object the
// detection loop's effect closure captured as soon as anything else
// triggers a re-render (e.g. the canvas-resize state update on the first
// tick) — the loop would then be reading a stale, permanently-null ref.
const mockVideoRef = { current: null }
vi.mock('../hooks/useCameraStream', () => ({
  useCameraStream: () => ({ videoRef: mockVideoRef, status: mockCameraStatus }),
}))

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: (key) => key }),
}))

const DETECTION_INTERVAL_MS = 90 // must match DeckCardScanner.jsx's own constant
const REQUIRED_STABLE_FRAMES = 8 // must match DeckCardScanner.jsx's own constant
const NUMBER_OCR_INTERVAL_MS = 700 // must match DeckCardScanner.jsx's own constant
const REQUIRED_HIGH_CONFIDENCE_PASSES = 3 // must match DeckCardScanner.jsx's own constant

const STABLE_QUAD = {
  topLeftCorner: { x: 10, y: 10 },
  topRightCorner: { x: 110, y: 10 },
  bottomLeftCorner: { x: 10, y: 160 },
  bottomRightCorner: { x: 110, y: 160 },
}

function fakeCropCanvas() {
  return { toBlob: (cb) => cb(new Blob(['fake'], { type: 'image/jpeg' })) }
}

// jsdom has no real <canvas>/<video> implementation — stub just enough for
// the detection loop to run without touching real pixels (detectCardQuad
// itself is mocked, so nothing here needs to draw anything meaningful).
function stubMediaAndCanvas() {
  const context2d = {
    clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context2d)
  // jsdom has no real toBlob() without the optional `canvas` npm package —
  // it warns and never invokes the callback at all, which would hang
  // attemptZoomMatch forever (Path B draws directly onto a real DOM canvas
  // ref, unlike Path A's mocked extractCard()). Path A itself never hits
  // this because its own crop comes from the mocked extractCard() return
  // value, not a raw canvas ref.
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(callback) {
    callback(new Blob(['fake'], { type: 'image/jpeg' }))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, value: 4 })
  // videoWidth/videoHeight are HTMLVideoElement-specific, not on the
  // HTMLMediaElement base class — jsdom's own HTMLVideoElement.prototype
  // getter (always 0) would otherwise shadow a value set on the parent.
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, value: 640 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, value: 480 })
}

// Advances the detection loop by n ticks, letting each tick's async work
// (detectCardQuad -> quadStability -> maybe captureAndRecognize) settle.
async function advanceTicks(n = 1) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DETECTION_INTERVAL_MS)
    })
  }
}

// Same idea as advanceTicks, but for Phase 3's Path B throttled loop
// (700ms cadence) rather than the 90ms detection loop.
async function advanceNumberOcrTicks(n = 1) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NUMBER_OCR_INTERVAL_MS)
    })
  }
}

describe('DeckCardScanner', () => {
  let onConfirm

  beforeEach(() => {
    vi.useFakeTimers()
    mockCameraStatus = 'streaming'
    stubMediaAndCanvas()
    detectCardQuad.mockResolvedValue(STABLE_QUAD)
    extractCard.mockResolvedValue(fakeCropCanvas())
    // Default: OCR finds nothing usable and the deck-scoped match isn't
    // confident either, so every existing test below still falls through
    // to the paid recognizeCard() path unchanged. Tests that specifically
    // cover the free tiers override these themselves.
    recognizeCardText.mockResolvedValue({ name: null, number_local: null })
    // Path B never fires by default (null read) — tests below that care
    // about it override this themselves.
    recognizeNumberRegion.mockResolvedValue({ number_local: null, number_total: null, confidence: 0 })
    matchDeckImage.mockResolvedValue({ _identity_confident: false, matches: [] })
    // Plain mutable objects, not vi.fn() mocks — clearAllMocks in afterEach
    // doesn't touch these, so reset explicitly to avoid one test's value
    // leaking into the next.
    lastOcrRawText.value = ''
    lastOcrWords.value = []
    onConfirm = vi.fn().mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    // restoreAllMocks only reverts vi.spyOn spies to their original
    // implementation — it does not clear vi.fn()/vi.mock() call history,
    // which was silently leaking between tests (a "not called at all"
    // assertion in a later test could see an earlier test's calls).
    // clearAllMocks resets that history too.
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('preloads detection as soon as it opens', () => {
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
    expect(preloadCardDetection).toHaveBeenCalled()
  })

  it('does not capture before the card has been held steady for the required streak', async () => {
    recognizeCard.mockResolvedValue({ _identity_confident: true, matches: [{ id: 'p1', name: 'Pikachu' }] })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES - 1)

    expect(recognizeCard).not.toHaveBeenCalled()
    expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()
  })

  it('auto-saves a confident match through the existing confirm path, then shows a checkmark and returns to hunting', async () => {
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    // Labeled so a saved trace can later be told apart from a manual scan
    // — see services/scan_trace.py's "source" field.
    expect(recognizeCard).toHaveBeenCalledWith(expect.anything(), 'live_auto_scan', expect.anything())
    // The quad passed here is scaled up from the downscaled detection
    // canvas to native (640x480) resolution — not STABLE_QUAD's raw
    // coordinates — so this checks shape/dimensions, not exact numbers.
    expect(extractCard).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement), 375, 525,
      expect.objectContaining({
        topLeftCorner: expect.any(Object),
        topRightCorner: expect.any(Object),
        bottomLeftCorner: expect.any(Object),
        bottomRightCorner: expect.any(Object),
      }),
    )
    expect(recognizeCard).toHaveBeenCalledTimes(1)
    // Not a new/parallel save path — routes through the same onConfirm the
    // manual candidate picker uses, with isAutoSave and the recognize
    // response's trace_id (for later undo correlation) threaded through.
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-abc123' },
    )
    expect(screen.getByLabelText('decks.scan.captured')).toBeInTheDocument()

    // Checkmark holds ~900ms, then a further ~600ms cooldown before
    // returning to hunting — see DeckCardScanner.jsx's CHECKMARK_DURATION_MS
    // / COOLDOWN_AFTER_CHECKMARK_MS.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

    expect(screen.queryByLabelText('decks.scan.captured')).not.toBeInTheDocument()
    expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()

    // The loop re-arms once the card is actually removed from frame — not
    // merely once cooldown elapses (see the next test: a still-sitting card
    // must NOT re-trigger a capture on its own).
    recognizeCard.mockClear()
    detectCardQuad.mockResolvedValueOnce(null)
    await advanceTicks(1)
    detectCardQuad.mockResolvedValue(STABLE_QUAD)
    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(recognizeCard).toHaveBeenCalledTimes(1)
  })

  it('shows a distinct warning (not the green checkmark) naming the card when the save did not count toward deck progress', async () => {
    // onConfirm resolves with the axios response add_to_collection actually
    // returns — deck_scan_status is set only when the scan didn't move deck
    // progress (see backend services/deck_progress.py's SCAN_* constants).
    // A silent identical-looking checkmark here was the exact bug report:
    // no way to tell an off-deck/duplicate scan apart from a real match.
    onConfirm.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'not_in_deck' } })
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(screen.queryByLabelText('decks.scan.captured')).not.toBeInTheDocument()
    // "Pikachu decks.scan.notInDeckDetail" — t is mocked to identity, so
    // the translated suffix comes through as its own raw key.
    expect(screen.getByText(/Pikachu decks\.scan\.notInDeckDetail/)).toBeInTheDocument()

    // 4s hold — a warning needs real reading time. Still up at the point a
    // checkmark (900ms) would already be long gone...
    await act(async () => { await vi.advanceTimersByTimeAsync(3700) })
    expect(screen.getByText(/Pikachu decks\.scan\.notInDeckDetail/)).toBeInTheDocument()

    // ...but gone by its own full 4s hold.
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.queryByText(/Pikachu decks\.scan\.notInDeckDetail/)).not.toBeInTheDocument()
  })

  it('shows the deck quantity in the warning for a card already at its expected quantity', async () => {
    onConfirm.mockResolvedValue({
      data: { card_id: 'p1', deck_scan_status: 'already_complete', deck_scan_quantity: 4 },
    })
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    // "4/4 Pikachu decks.scan.alreadyCompleteDetail" — deck_scan_quantity
    // covers both sides of the fraction (scanned_quantity always equals it
    // in this state, see register_scan).
    expect(screen.getByText(/4\/4 Pikachu decks\.scan\.alreadyCompleteDetail/)).toBeInTheDocument()
  })

  it('keeps the video feed live behind a warning, unlike the frozen frame behind the green checkmark', async () => {
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })

    // Baseline: the green-checkmark path still freezes the feed — real-device
    // report was specifically about the warning, not this.
    onConfirm.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'counted' } })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    cleanup()
    vi.clearAllMocks()

    // The warning path: the feed must keep playing underneath it.
    onConfirm.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'not_in_deck' } })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
  })

  it('dismisses the warning early on tap, returning straight to hunting', async () => {
    onConfirm.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'not_in_deck' } })
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)
    const warning = screen.getByText(/Pikachu decks\.scan\.notInDeckDetail/)

    await act(async () => { fireEvent.click(warning) })

    // Gone well before WARNING_DURATION_MS (4s) would have elapsed on its
    // own — a tap ends it immediately, not just shortens the wait.
    expect(screen.queryByText(/Pikachu decks\.scan\.notInDeckDetail/)).not.toBeInTheDocument()
    expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()
  })

  it('does not immediately re-capture the same still-visible card right after a successful auto-save', async () => {
    // Real-device finding: a card the user hasn't physically moved away yet
    // was getting auto-detected as stable again within ~3s of a successful
    // save, firing a second, unintended (and costly) recognize call.
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(recognizeCard).toHaveBeenCalledTimes(1)

    recognizeCard.mockClear()
    // Checkmark + cooldown elapse, but detectCardQuad keeps returning the
    // same STABLE_QUAD throughout — the card was never actually removed.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(recognizeCard).not.toHaveBeenCalled()
  })

  it('captures a new card swapped in right after a save, even when the frame is never empty in between', async () => {
    // Real-device finding: sliding the next card into frame before the
    // previous one is fully out never produces a "no quad" tick. A plain
    // boolean gate cleared only by an empty frame left this permanently
    // blocking capture — every card after the first few silently stopped
    // auto-scanning until the user closed and reopened the scanner.
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(recognizeCard).toHaveBeenCalledTimes(1)

    recognizeCard.mockClear()
    onConfirm.mockClear()
    // Checkmark + cooldown elapse (see CHECKMARK_DURATION_MS /
    // COOLDOWN_AFTER_CHECKMARK_MS) — detectCardQuad is never made to
    // return null at any point, matching a fast physical swap.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

    const SWAPPED_QUAD = {
      topLeftCorner: { x: 300, y: 250 },
      topRightCorner: { x: 400, y: 250 },
      bottomLeftCorner: { x: 300, y: 400 },
      bottomRightCorner: { x: 400, y: 400 },
    }
    detectCardQuad.mockResolvedValue(SWAPPED_QUAD)
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p2', name: 'Charmander' }],
      trace_id: 'trace-def456',
    })
    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(recognizeCard).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p2' }),
      { isAutoSave: true, traceId: 'trace-def456' },
    )
  })

  it('falls back to the tap-to-confirm picker on an ambiguous match, and pauses further auto-capture while it is shown', async () => {
    recognizeCard.mockResolvedValue({
      _identity_confident: false,
      matches: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
      trace_id: 'trace-ambiguous1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText('Card A')).toBeInTheDocument()
    expect(screen.getByText('Card B')).toBeInTheDocument()

    // Ambiguous is not "hunting" — the detection loop must not still be
    // capturing behind the picker.
    recognizeCard.mockClear()
    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(recognizeCard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Card A'))
    await act(async () => { await Promise.resolve() })

    // A manual tap still carries the recognize response's trace_id through
    // (for undo correlation), just with isAutoSave: false.
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      { isAutoSave: false, traceId: 'trace-ambiguous1' },
    )
    expect(screen.getByLabelText('decks.scan.captured')).toBeInTheDocument()
  })

  it('shows the manual take-photo fallback when the camera is denied, not the live view', () => {
    mockCameraStatus = 'denied'
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    expect(screen.getByText('decks.scan.cameraUnavailable')).toBeInTheDocument()
    expect(screen.getByText('decks.scan.takePhoto')).toBeInTheDocument()
    expect(screen.queryByText('decks.scan.liveHint')).not.toBeInTheDocument()
  })

  it('labels a manual-fallback scan "manual", not "live_auto_scan"', async () => {
    mockCameraStatus = 'denied'
    recognizeCard.mockResolvedValue({
      _identity_confident: false,
      matches: [{ id: 'a', name: 'Card A' }],
      trace_id: 'trace-manual1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    // Rendered via createPortal(..., document.body) — outside RTL's own
    // container div, so this has to search the whole document.
    const fileInput = document.querySelector('input[type="file"]')
    const file = new File(['fake'], 'card.jpg', { type: 'image/jpeg' })
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } })
    })

    expect(recognizeCard).toHaveBeenCalledWith(file, 'manual', expect.anything())
    expect(screen.getByText('Card A')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Card A'))
    await act(async () => { await Promise.resolve() })

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      { isAutoSave: false, traceId: 'trace-manual1' },
    )
  })

  it('surfaces a retry banner if recognizeCard itself fails, and returns to hunting on retry', async () => {
    recognizeCard.mockRejectedValue(new Error('network down'))
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(screen.getByText('decks.scan.failed')).toBeInTheDocument()

    fireEvent.click(screen.getByText('decks.scan.tryAgain'))
    expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()
  })

  it('auto-saves via the free deck-scoped match without ever calling the paid recognizeCard', async () => {
    recognizeCardText.mockResolvedValue({ name: 'Pikachu', number_local: '25' })
    matchDeckImage.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-deck1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(matchDeckImage).toHaveBeenCalledWith(
      '3',
      expect.anything(),
      { numberLocal: '25', name: 'Pikachu' },
      'live_auto_scan',
      expect.anything(),
    )
    expect(recognizeCard).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-deck1' },
    )
  })

  it('still tries the deck-scoped match with no OCR hints at all — pHash alone can resolve a card', async () => {
    // Real design point: unlike the retired broad-catalog match-text tier
    // (which required a name to search by), the deck-scoped match can
    // resolve purely from the image against this deck's own small,
    // known candidate list — a total OCR failure shouldn't skip it.
    recognizeCardText.mockResolvedValue({ name: null, number_local: null })
    matchDeckImage.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-deck2',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(matchDeckImage).toHaveBeenCalledWith(
      '3', expect.anything(), { numberLocal: null, name: null }, 'live_auto_scan', expect.anything(),
    )
    expect(recognizeCard).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-deck2' },
    )
  })

  it('never attempts the deck-scoped match without a deckInstanceId, going straight to the paid call', async () => {
    recognizeCardText.mockResolvedValue({ name: 'Pikachu', number_local: '25' })
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-paid4',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(matchDeckImage).not.toHaveBeenCalled()
    expect(recognizeCard).toHaveBeenCalledWith(expect.anything(), 'live_auto_scan', expect.anything())
  })

  it('runs OCR against its own higher-resolution crop, separate from the smaller one uploaded to the paid API', async () => {
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    // Two distinct extractCard calls: one at the upload size, one larger
    // for OCR only (never uploaded, so its cost is CPU/time, not bandwidth).
    expect(extractCard).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement), 375, 525, expect.anything(),
    )
    expect(extractCard).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement), 750, 1050, expect.anything(),
    )
  })

  it('retries OCR at the smaller crop size if the larger one throws, and still resolves via the deck match', async () => {
    // Real-device finding: worker.recognize() rejected outright on the
    // larger OCR-only crop, with no usable error reason (a Tesseract
    // worker crash rejects with undefined, not an Error — see
    // describeError in DeckCardScanner.jsx). Whatever the cause, a
    // genuinely smaller retry should still be able to succeed.
    recognizeCardText
      .mockRejectedValueOnce(undefined)
      .mockResolvedValueOnce({ name: 'Pikachu', number_local: '25' })
    matchDeckImage.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-retry1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(recognizeCardText).toHaveBeenCalledTimes(2)
    expect(matchDeckImage).toHaveBeenCalledWith(
      '3', expect.anything(), { numberLocal: '25', name: 'Pikachu' }, 'live_auto_scan', expect.anything(),
    )
    expect(recognizeCard).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-retry1' },
    )
  })

  it('still tries the deck-scoped match, with a readable error logged, when OCR fails at both crop sizes', async () => {
    recognizeCardText.mockRejectedValue(undefined)
    matchDeckImage.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-deck3',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(recognizeCardText).toHaveBeenCalledTimes(2)
    // No OCR hints at all, but the deck-scoped match still runs — pure
    // pHash against this deck's own missing cards.
    expect(matchDeckImage).toHaveBeenCalledWith(
      '3', expect.anything(), { numberLocal: undefined, name: undefined }, 'live_auto_scan', expect.anything(),
    )
    expect(recognizeCard).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-deck3' },
    )
  })

  it('surfaces what OCR actually found in the on-screen debug readout', async () => {
    // Debug readout only renders in the camera-view phases (hunting/
    // processing/success/error), not the candidate-picker view — land in
    // 'error' (paid call also fails) so it's actually on screen to assert
    // against, while still proving debugInfo captured the OCR result from
    // the earlier, successful tryOcrMatch step.
    recognizeCardText.mockResolvedValue({ name: 'Pikachu', number_local: '25' })
    lastOcrRawText.value = 'Pikachu\nHP 60\n025/198'
    lastOcrWords.value = [{ text: 'Pikachu', confidence: 91, y0: 90 }]
    matchDeckImage.mockResolvedValue({ _identity_confident: false, matches: [] })
    recognizeCard.mockRejectedValue(new Error('network down'))
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(document.body.textContent).toContain('ocr name:Pikachu')
    expect(document.body.textContent).toContain('number:25')
    expect(document.body.textContent).toContain('ocr raw:')
    expect(document.body.textContent).toContain('Pikachu HP 60 025/198')
    // The word-level readout — proves pickCardName's actual input (not
    // just its output) is visible, so a rejected-but-real candidate can be
    // told apart from Tesseract finding nothing usable at all.
    expect(document.body.textContent).toContain('ocr words:')
    expect(document.body.textContent).toContain('"Pikachu"@y90(91)')
  })

  it('shows rejected OCR word candidates in the debug readout even when no name was picked', async () => {
    // The real-device gap this closes: "ocr name:(none)" alone can't say
    // whether nothing was recognized, or something was recognized but
    // scored below MIN_NAME_CONFIDENCE / outside NAME_BAND_FRACTION.
    recognizeCardText.mockResolvedValue({ name: null })
    lastOcrRawText.value = 'garbled nonsense'
    lastOcrWords.value = [
      { text: 'Potion', confidence: 22, y0: 90 }, // real word, too low-confidence
      { text: 'garbled', confidence: 61, y0: 600 }, // confident but out of band
    ]
    recognizeCard.mockRejectedValue(new Error('network down'))
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(document.body.textContent).toContain('ocr name:(none)')
    expect(document.body.textContent).toContain('"garbled"@y600(61)')
    expect(document.body.textContent).toContain('"Potion"@y90(22)')
  })

  it('shows "(empty)" for the raw OCR readout when Tesseract found nothing at all', async () => {
    // The real-device finding this guards: a well-lit, legible card still
    // produced name:(none) number:(none) — this line is what tells apart
    // "Tesseract found nothing" from "found text the parser couldn't use."
    recognizeCardText.mockResolvedValue({ name: null })
    lastOcrRawText.value = ''
    recognizeCard.mockRejectedValue(new Error('network down'))
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(document.body.textContent).toContain('ocr raw:(empty)')
  })

  it('falls back to the paid recognizeCard when the deck-scoped match was not confident', async () => {
    recognizeCardText.mockResolvedValue({ name: 'Pikachu', number_local: '25' })
    matchDeckImage.mockResolvedValue({
      _identity_confident: false,
      matches: [],
    })
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-paid1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(matchDeckImage).toHaveBeenCalled()
    expect(recognizeCard).toHaveBeenCalledWith(expect.anything(), 'live_auto_scan', expect.anything())
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-paid1' },
    )
  })

  it('shows a cancel option as soon as processing starts, not gated behind the "still working" delay', async () => {
    matchDeckImage.mockImplementation(() => new Promise(() => {})) // never settles in this test
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(screen.getByText('decks.scan.cancel')).toBeInTheDocument()
    // The "still working" reassurance is still delayed — only the ability
    // to back out is immediate.
    expect(screen.queryByText(/Still working/)).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(screen.getByText('decks.scan.cancel')).toBeInTheDocument()
    expect(screen.getByText(/Still working/)).toBeInTheDocument()
  })

  it('cancelling a long-running match returns to hunting without ever falling through to the paid call', async () => {
    // Mirrors what a real cancelled axios request does: rejects once the
    // AbortSignal fires, rather than resolving/rejecting on its own.
    matchDeckImage.mockImplementation((instanceId, blob, fields, source, signal) => (
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('canceled')
          err.name = 'CanceledError'
          reject(err)
        })
      })
    ))
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)
    // No delay first — the button is available immediately, not just once
    // processing has been running a while.
    await act(async () => {
      fireEvent.click(screen.getByText('decks.scan.cancel'))
      await Promise.resolve()
    })

    // Cancelling is not a failure — straight back to hunting, not the
    // error banner, and critically not a silent fall-through to the paid
    // call the user explicitly asked to stop waiting for.
    expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()
    expect(screen.queryByText('decks.scan.failed')).not.toBeInTheDocument()
    expect(recognizeCard).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  describe('Path B — throttled number-only OCR pass', () => {
    // Path B's main case is no quad at all (zoomed in past the card's
    // edges) — nulling detectCardQuad also keeps Path A's own 90ms loop
    // from accumulating a stability streak and interfering, since
    // advanceNumberOcrTicks's 700ms fake-timer advances also tick the 90ms
    // detection interval along the way.
    beforeEach(() => {
      detectCardQuad.mockResolvedValue(null)
    })

    it('does not start a new pass while one is still in flight', async () => {
      let resolveRegion
      recognizeNumberRegion.mockImplementation(() => new Promise((resolve) => { resolveRegion = resolve }))
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      await advanceNumberOcrTicks(1)
      expect(recognizeNumberRegion).toHaveBeenCalledTimes(1)

      // Two more ticks elapse while the first pass is still unresolved —
      // the serial guard must skip starting new ones, not queue them.
      await advanceNumberOcrTicks(2)
      expect(recognizeNumberRegion).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolveRegion({ number_local: null, number_total: null, confidence: 0 })
        await Promise.resolve()
      })
      await advanceNumberOcrTicks(1)
      expect(recognizeNumberRegion).toHaveBeenCalledTimes(2)
    })

    it('shows a name preview once the read number uniquely matches a missing card, independent of the auto-trigger threshold', async () => {
      recognizeNumberRegion.mockResolvedValue({ number_local: '25', number_total: '198', confidence: 60 })
      render(
        <DeckCardScanner
          isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3"
          missingCards={[{ number: '25', name: 'Pikachu' }]}
        />,
      )

      await advanceNumberOcrTicks(1)

      expect(screen.getByText('Pikachu')).toBeInTheDocument()
      // 60% is below the auto-trigger threshold — a preview, not a save.
      expect(matchDeckImage).not.toHaveBeenCalled()
    })

    it('does not attempt a match until confidence sustains for the required streak, only 1-2 passes', async () => {
      recognizeNumberRegion.mockResolvedValue({ number_local: '25', number_total: '198', confidence: 85 })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      await advanceNumberOcrTicks(REQUIRED_HIGH_CONFIDENCE_PASSES - 1)

      expect(matchDeckImage).not.toHaveBeenCalled()
    })

    it('auto-saves through the existing confirm path once confidence sustains, skipping pHash and labeling the source', async () => {
      recognizeNumberRegion.mockResolvedValue({ number_local: '25', number_total: '198', confidence: 85 })
      matchDeckImage.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-zoom1',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      await advanceNumberOcrTicks(REQUIRED_HIGH_CONFIDENCE_PASSES)

      // skip_phash (6th arg) true, and a distinct source — this is a
      // number-only crop, not a full-card photo, so pHash must not run
      // server-side against it (see the plan's "pHash false-positive
      // risk").
      expect(matchDeckImage).toHaveBeenCalledWith(
        '3', expect.anything(), { numberLocal: '25', name: null }, 'live_zoom_scan', expect.anything(), true,
      )
      // Not a second/parallel save path — the same confirmCard/onConfirm
      // route Path A already uses.
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        { isAutoSave: true, traceId: 'trace-zoom1' },
      )
    })

    it('resumes scanning without a picker when the match is not confident, unlike Path A', async () => {
      recognizeNumberRegion.mockResolvedValue({ number_local: '25', number_total: '198', confidence: 85 })
      matchDeckImage.mockResolvedValue({ _identity_confident: false, matches: [] })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      await advanceNumberOcrTicks(REQUIRED_HIGH_CONFIDENCE_PASSES)

      expect(recognizeCard).not.toHaveBeenCalled()
      expect(onConfirm).not.toHaveBeenCalled()
      expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()
    })
  })

  describe('recent-scans stack', () => {
    it('adds the confirmed card to the recent-scans stack after a successful save', async () => {
      recognizeCard.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-stack1',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      await advanceTicks(REQUIRED_STABLE_FRAMES)

      const thumb = screen.getByAltText('Pikachu')
      expect(thumb).toHaveAttribute('src', '/api/images/card/p1/small')
    })

    it('keeps recently confirmed cards in scan order, newest last', async () => {
      recognizeCard.mockResolvedValueOnce({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-stack2a',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
      await advanceTicks(REQUIRED_STABLE_FRAMES)

      // Same choreography the "captures a new card swapped in" test above
      // uses to get a second real capture through the state machine: let
      // the checkmark/cooldown elapse, then swap in a card at a position
      // far enough away to clear awaitingCardRemovalRef.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      const SWAPPED_QUAD = {
        topLeftCorner: { x: 300, y: 250 },
        topRightCorner: { x: 400, y: 250 },
        bottomLeftCorner: { x: 300, y: 400 },
        bottomRightCorner: { x: 400, y: 400 },
      }
      detectCardQuad.mockResolvedValue(SWAPPED_QUAD)
      recognizeCard.mockResolvedValueOnce({
        _identity_confident: true,
        matches: [{ id: 'p2', name: 'Charmander' }],
        trace_id: 'trace-stack2b',
      })
      await advanceTicks(REQUIRED_STABLE_FRAMES)

      // The stack appends (newest last), it doesn't prepend — Pikachu
      // (scanned first) must still precede Charmander in DOM order.
      const names = screen.getAllByRole('img').map((img) => img.getAttribute('alt'))
      expect(names.indexOf('Pikachu')).toBeLessThan(names.indexOf('Charmander'))
    })

    it('drops the oldest thumbnail once the stack exceeds its cap', async () => {
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      // One more scan than RECENT_SCANS_LIMIT (3) — same null-quad/
      // STABLE_QUAD re-arm technique the "does not immediately re-capture"
      // test above uses to get a fresh capture through the state machine
      // each time, rather than a position-based swap.
      for (let i = 0; i < 4; i++) {
        recognizeCard.mockResolvedValueOnce({
          _identity_confident: true,
          matches: [{ id: `p${i}`, name: `Card${i}` }],
          trace_id: `trace-cap${i}`,
        })
        await advanceTicks(REQUIRED_STABLE_FRAMES)
        await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
        detectCardQuad.mockResolvedValueOnce(null)
        await advanceTicks(1)
        detectCardQuad.mockResolvedValue(STABLE_QUAD)
      }

      expect(recognizeCard).toHaveBeenCalledTimes(4)
      // Card0 (the oldest, first scanned) has been dropped; the other 3
      // remain.
      expect(screen.queryByAltText('Card0')).not.toBeInTheDocument()
      expect(screen.getAllByRole('img')).toHaveLength(3)
      expect(screen.getByAltText('Card3')).toBeInTheDocument()
    })

    it('keeps the recent-scans stack when the scanner is closed and reopened', async () => {
      // Real-device feedback: closing the scanner and coming straight back
      // (e.g. to check something else in the app) shouldn't wipe the scan
      // history the user was just looking at.
      recognizeCard.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-reset1',
      })
      const { rerender } = render(
        <DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />,
      )
      await advanceTicks(REQUIRED_STABLE_FRAMES)
      expect(screen.getByAltText('Pikachu')).toBeInTheDocument()

      rerender(<DeckCardScanner isOpen={false} onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
      rerender(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      expect(screen.getByAltText('Pikachu')).toBeInTheDocument()
    })

    it('lets a tap on a recent-scan thumbnail add another copy of that same card', async () => {
      recognizeCard.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-quickadd1',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
      await advanceTicks(REQUIRED_STABLE_FRAMES)
      expect(onConfirm).toHaveBeenCalledTimes(1)

      // Checkmark + cooldown elapse — quick-add only fires while actively
      // hunting again (see quickAddRecentScan's own guard), same as the
      // "does not immediately re-capture" test above.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

      await act(async () => {
        fireEvent.click(screen.getByLabelText('decks.scan.quickAdd: Pikachu'))
        await Promise.resolve()
      })

      // Routes through the exact same confirmCard path a manual tap in the
      // ambiguous list uses (isAutoSave: false), not a new/parallel save —
      // and produces a second stack entry for the same card.
      expect(onConfirm).toHaveBeenCalledTimes(2)
      expect(onConfirm).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'p1' }),
        { isAutoSave: false, traceId: null },
      )
      expect(screen.getAllByRole('img')).toHaveLength(2)
    })

    it('disables the quick-add button while the scanner is not actively hunting', async () => {
      recognizeCard.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-quickadd2',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
      await advanceTicks(REQUIRED_STABLE_FRAMES)

      // Still mid checkmark/cooldown right after the auto-save — phase is
      // 'success', not 'hunting'.
      const quickAddButton = screen.getByLabelText('decks.scan.quickAdd: Pikachu')
      expect(quickAddButton).toBeDisabled()

      onConfirm.mockClear()
      fireEvent.click(quickAddButton)
      expect(onConfirm).not.toHaveBeenCalled()
    })


    it('shows a visible error, without losing hunting mode, when a quick-add fails to save', async () => {
      // Regression test: confirmError was previously only ever rendered in
      // the 'ambiguous' picker view — a failed quick-add (which only ever
      // fires from 'hunting') set the same state but nothing showed it, so
      // the thumbnail's spinner just stopped with no explanation.
      recognizeCard.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-quickaddfail1',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
      await advanceTicks(REQUIRED_STABLE_FRAMES)
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

      onConfirm.mockRejectedValueOnce(new Error('network down'))
      await act(async () => {
        fireEvent.click(screen.getByLabelText('decks.scan.quickAdd: Pikachu'))
        await Promise.resolve()
      })

      expect(screen.getByText('decks.scan.confirmFailed')).toBeInTheDocument()
      // Still hunting, not bounced to an error phase — the failure is
      // surfaced, not treated as fatal to the whole scanner.
      expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()
    })

    it('shows which path resolved an auto-save as a badge on its recent-scans thumbnail', async () => {
      recognizeCard.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-path1',
        _identity_decision: 'gemini_visual',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      await advanceTicks(REQUIRED_STABLE_FRAMES)

      expect(screen.getByText('decks.scan.pathVisionApi')).toBeInTheDocument()
    })

    it('maps the free deck-scoped tier\'s own decision vocabulary to the same shared labels', async () => {
      // deck_phash (matchDeckImage's own vocabulary) and phash (the paid
      // route's) both mean "image match" — proves decisionLabelKey handles
      // both routes' different raw strings for the same underlying idea.
      recognizeCardText.mockResolvedValue({ name: null, number_local: '25' })
      matchDeckImage.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-path2',
        _identity_decision: 'deck_phash',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

      await advanceTicks(REQUIRED_STABLE_FRAMES)

      expect(screen.getByText('decks.scan.pathImageMatch')).toBeInTheDocument()
    })

    it('carries the original decision forward onto a quick-added copy of the same card', async () => {
      recognizeCardText.mockResolvedValue({ name: null, number_local: '25' })
      matchDeckImage.mockResolvedValue({
        _identity_confident: true,
        matches: [{ id: 'p1', name: 'Pikachu' }],
        trace_id: 'trace-path3',
        _identity_decision: 'deck_number_unique',
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
      await advanceTicks(REQUIRED_STABLE_FRAMES)
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

      await act(async () => {
        fireEvent.click(screen.getByLabelText('decks.scan.quickAdd: Pikachu'))
        await Promise.resolve()
      })

      // Same card, identified the same way — not a fresh recognition
      // event, so the quick-added copy's badge should match the original's.
      expect(screen.getAllByText('decks.scan.pathOcrNumber')).toHaveLength(2)
    })

    it('shows no path badge for a card saved from a manual pick in the ambiguous list', async () => {
      // An ambiguous match is never auto-resolved (that's what "ambiguous"
      // means) — the backend never sets a decision for one, so there's
      // nothing honest to label here.
      recognizeCard.mockResolvedValue({
        _identity_confident: false,
        matches: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
        trace_id: 'trace-path4',
        _identity_decision: null,
      })
      render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)
      await advanceTicks(REQUIRED_STABLE_FRAMES)

      fireEvent.click(screen.getByText('Card A'))
      await act(async () => { await Promise.resolve() })

      expect(screen.queryByText('decks.scan.pathImageMatch')).not.toBeInTheDocument()
      expect(screen.queryByText('decks.scan.pathOcrNumber')).not.toBeInTheDocument()
      expect(screen.queryByText('decks.scan.pathOcrName')).not.toBeInTheDocument()
      expect(screen.queryByText('decks.scan.pathMetadata')).not.toBeInTheDocument()
      expect(screen.queryByText('decks.scan.pathVisionApi')).not.toBeInTheDocument()
    })
  })

  it('clears the detection outline the instant a capture starts, not once the result banner disappears', async () => {
    // handleScanNow (unlike the auto-hold tick loop, which redraws the
    // outline via drawOverlay every tick) never itself touches the overlay
    // canvas — so any clearRect on it after this triggers can only be the
    // phase-change cleanup effect's own doing, not drawOverlay's regular
    // per-tick redraw. matchDeckImage never resolving keeps phase pinned
    // at 'processing' so there's no race with the checkmark/cooldown timers.
    matchDeckImage.mockImplementation(() => new Promise(() => {}))
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} deckInstanceId="3" />)

    // One tick so the overlay canvas has real dimensions and latestQuadRef
    // has a quad to seed handleScanNow's capture with.
    await advanceTicks(1)

    const context2d = HTMLCanvasElement.prototype.getContext()
    context2d.clearRect.mockClear()

    await act(async () => {
      fireEvent.click(screen.getByText('decks.scan.scanNow'))
      await Promise.resolve()
    })

    expect(context2d.clearRect).toHaveBeenCalledWith(0, 0, 640, 480)
  })
})
