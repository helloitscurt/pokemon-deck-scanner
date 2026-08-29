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
import { matchCardText, recognizeCard } from '../api/client'
import { detectCardQuad, extractCard, preloadCardDetection } from '../utils/cardDetection'
import { recognizeCardText } from '../utils/cardOcr'

vi.mock('../api/client', () => ({
  recognizeCard: vi.fn(),
  matchCardText: vi.fn(),
}))

vi.mock('../utils/cardDetection', () => ({
  detectCardQuad: vi.fn(),
  extractCard: vi.fn(),
  preloadCardDetection: vi.fn(),
  detectionStatus: { state: 'ready', error: null },
}))

vi.mock('../utils/cardOcr', () => ({
  recognizeCardText: vi.fn(),
  preloadCardOcr: vi.fn(),
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

const DETECTION_INTERVAL_MS = 180
const REQUIRED_STABLE_FRAMES = 5

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

describe('DeckCardScanner', () => {
  let onConfirm

  beforeEach(() => {
    vi.useFakeTimers()
    mockCameraStatus = 'streaming'
    stubMediaAndCanvas()
    detectCardQuad.mockResolvedValue(STABLE_QUAD)
    extractCard.mockResolvedValue(fakeCropCanvas())
    // Default: OCR finds nothing usable, so tryOcrMatch short-circuits and
    // every existing test below exercises the paid recognizeCard() path
    // unchanged. Tests that specifically cover the Phase 2 OCR path
    // override this themselves.
    recognizeCardText.mockResolvedValue({ name: null })
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
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)
    expect(preloadCardDetection).toHaveBeenCalled()
  })

  it('does not capture before the card has been held steady for the required streak', async () => {
    recognizeCard.mockResolvedValue({ _identity_confident: true, matches: [{ id: 'p1', name: 'Pikachu' }] })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

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
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    // Labeled so a saved trace can later be told apart from a manual scan
    // — see services/scan_trace.py's "source" field.
    expect(recognizeCard).toHaveBeenCalledWith(expect.anything(), 'live_auto_scan')
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

  it('does not immediately re-capture the same still-visible card right after a successful auto-save', async () => {
    // Real-device finding: a card the user hasn't physically moved away yet
    // was getting auto-detected as stable again within ~3s of a successful
    // save, firing a second, unintended (and costly) recognize call.
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-abc123',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)
    expect(recognizeCard).toHaveBeenCalledTimes(1)

    recognizeCard.mockClear()
    // Checkmark + cooldown elapse, but detectCardQuad keeps returning the
    // same STABLE_QUAD throughout — the card was never actually removed.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(recognizeCard).not.toHaveBeenCalled()
  })

  it('falls back to the tap-to-confirm picker on an ambiguous match, and pauses further auto-capture while it is shown', async () => {
    recognizeCard.mockResolvedValue({
      _identity_confident: false,
      matches: [{ id: 'a', name: 'Card A' }, { id: 'b', name: 'Card B' }],
      trace_id: 'trace-ambiguous1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

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
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

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
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    // Rendered via createPortal(..., document.body) — outside RTL's own
    // container div, so this has to search the whole document.
    const fileInput = document.querySelector('input[type="file"]')
    const file = new File(['fake'], 'card.jpg', { type: 'image/jpeg' })
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } })
    })

    expect(recognizeCard).toHaveBeenCalledWith(file, 'manual')
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
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(screen.getByText('decks.scan.failed')).toBeInTheDocument()

    fireEvent.click(screen.getByText('decks.scan.tryAgain'))
    expect(screen.getByText('decks.scan.liveHint')).toBeInTheDocument()
  })

  it('auto-saves via the free OCR match-text path without ever calling the paid recognizeCard', async () => {
    recognizeCardText.mockResolvedValue({ name: 'Pikachu', number_local: '25' })
    matchCardText.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-ocr1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(matchCardText).toHaveBeenCalledWith(
      { name: 'Pikachu', number_local: '25' },
      expect.anything(),
      'live_auto_scan',
    )
    expect(recognizeCard).not.toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-ocr1' },
    )
  })

  it('runs OCR against its own higher-resolution crop, separate from the smaller one uploaded to the paid API', async () => {
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

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

  it('surfaces what OCR actually found in the on-screen debug readout', async () => {
    // Debug readout only renders in the camera-view phases (hunting/
    // processing/success/error), not the candidate-picker view — land in
    // 'error' (paid call also fails) so it's actually on screen to assert
    // against, while still proving debugInfo captured the OCR result from
    // the earlier, successful tryOcrMatch step.
    recognizeCardText.mockResolvedValue({ name: 'Pikachu', number_local: '25' })
    matchCardText.mockResolvedValue({ _identity_confident: false, matches: [] })
    recognizeCard.mockRejectedValue(new Error('network down'))
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(document.body.textContent).toContain('ocr name:Pikachu')
    expect(document.body.textContent).toContain('number:25')
  })

  it('falls back to the paid recognizeCard when OCR found a name but match-text was not confident', async () => {
    recognizeCardText.mockResolvedValue({ name: 'Pikachu', number_local: '25' })
    matchCardText.mockResolvedValue({
      _identity_confident: false,
      matches: [{ id: 'guess', name: 'Pikachu' }],
    })
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-paid1',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(matchCardText).toHaveBeenCalled()
    expect(recognizeCard).toHaveBeenCalledWith(expect.anything(), 'live_auto_scan')
    // The not-confident OCR guess is discarded, not shown — the paid
    // call's own result is what gets auto-saved.
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      { isAutoSave: true, traceId: 'trace-paid1' },
    )
  })

  it('skips match-text entirely when OCR found no usable name, going straight to the paid call', async () => {
    recognizeCardText.mockResolvedValue({ name: null })
    recognizeCard.mockResolvedValue({
      _identity_confident: true,
      matches: [{ id: 'p1', name: 'Pikachu' }],
      trace_id: 'trace-paid2',
    })
    render(<DeckCardScanner isOpen onClose={vi.fn()} onConfirm={onConfirm} />)

    await advanceTicks(REQUIRED_STABLE_FRAMES)

    expect(matchCardText).not.toHaveBeenCalled()
    expect(recognizeCard).toHaveBeenCalledWith(expect.anything(), 'live_auto_scan')
  })
})
