import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Camera, Check, Loader2, X } from 'lucide-react'
import { matchDeckImage, recognizeCard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import { useCameraStream } from '../hooks/useCameraStream'
import { detectCardQuad, detectionStatus, extractCard, preloadCardDetection } from '../utils/cardDetection'
import { lastOcrRawText, lastOcrWords, preloadCardOcr, recognizeCardText } from '../utils/cardOcr'
import { createStabilityTracker, quadsAreStable } from '../utils/quadStability'

// Real-device tuning, three passes: first (5 frames @ 2% tolerance @
// 180ms = 900ms dwell) felt slow and twitchy — ordinary jitter from
// lighting/shadows on the downscaled 480px-wide detection frame kept
// exceeding tolerance and resetting the streak. Second loosened both.
// Third halved the tick interval (180ms -> 90ms) and cut required frames
// to 3, landing at 270ms dwell — too little: capture was firing before
// the phone's own camera autofocus had actually settled, visible as
// consistently poor OCR on small print (collector numbers) specifically,
// even though the detected quad itself looked "stable" the whole time —
// quad stability and focus sharpness are different things the quad alone
// can't see. Required frames raised back up (3 -> 8, 720ms dwell) to give
// autofocus real time to lock before the crop is taken; interval stays at
// 90ms (unrelated to this — that's sampling rate, not dwell time) and
// tolerance stays loose (jitter was never the accuracy problem).
const DETECTION_INTERVAL_MS = 90
const REQUIRED_STABLE_FRAMES = 8
const STABILITY_TOLERANCE_PROPORTION = 0.07
const CHECKMARK_DURATION_MS = 900
const COOLDOWN_AFTER_CHECKMARK_MS = 600
// Detection runs on a downscaled frame — full contour detection on a native
// camera resolution every ~180ms is too slow for a phone browser. The crop
// sent to recognizeCard is re-drawn at native resolution at capture time
// instead (see captureAndRecognize), so downscaling here only costs
// detection accuracy, not recognition quality.
const DETECTION_MAX_WIDTH = 480
// A Pokémon card is ~2.5in x 3.5in — same ratio used for the crop sent to
// recognizeCard, independent of whatever aspect ratio the camera itself is.
const CARD_CROP_WIDTH = 375
const CARD_CROP_HEIGHT = 525
// A separate, higher-resolution crop for OCR only (never uploaded, so its
// size costs client CPU/time, not bandwidth) — Tesseract's accuracy on
// small printed text benefits from more source pixels than the paid API's
// upload needs to stay small and fast. Same 2.5:3.5 ratio, just 2x scale.
const OCR_CROP_WIDTH = CARD_CROP_WIDTH * 2
const OCR_CROP_HEIGHT = CARD_CROP_HEIGHT * 2

const ERROR_BANNER_CLASS = 'card border-brand-red/30 bg-brand-red/5 text-center py-4'

// err?.message || err renders the literal string "undefined" when err
// itself is undefined/null (a caught rejection with no reason — observed
// for real from a Tesseract.js worker.recognize() failure on a real
// device) instead of anything diagnostic. Not specific to OCR, so kept
// generic rather than folded into one call site.
function describeError(err) {
  if (err instanceof Error) return err.message || err.name || 'Error'
  if (typeof err === 'string' && err) return err
  if (err === undefined || err === null) return '(no error details — worker may have crashed)'
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function scaleQuad(quad, scaleX, scaleY) {
  const scalePoint = ({ x, y }) => ({ x: x * scaleX, y: y * scaleY })
  return {
    topLeftCorner: scalePoint(quad.topLeftCorner),
    topRightCorner: scalePoint(quad.topRightCorner),
    bottomLeftCorner: scalePoint(quad.bottomLeftCorner),
    bottomRightCorner: scalePoint(quad.bottomRightCorner),
  }
}

// This app supports multiple color themes (data-theme="fire"|"water"|...,
// see index.css), each overriding --color-brand-red — read live rather
// than hardcoding the default hex, so the detection outline matches
// whichever theme is actually active instead of always showing default red.
function currentBrandRed() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-brand-red').trim()
  return value || '#e3000b'
}

// Clears the overlay and, when a quad was found, strokes its outline.
// Color signals progress toward a capture: dim while a card is only just
// detected, the active theme's brand-red while it's being held steady and
// the stability streak is building toward the capture threshold.
function drawOverlay(canvas, quad, stableFraction) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!quad) return

  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = quad
  ctx.strokeStyle = stableFraction > 0.2 ? currentBrandRed() : 'rgba(255,255,255,0.6)'
  ctx.lineWidth = Math.max(2, canvas.width * 0.006)
  ctx.beginPath()
  ctx.moveTo(topLeftCorner.x, topLeftCorner.y)
  ctx.lineTo(topRightCorner.x, topRightCorner.y)
  ctx.lineTo(bottomRightCorner.x, bottomRightCorner.y)
  ctx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y)
  ctx.closePath()
  ctx.stroke()
}

/**
 * DeckCardScanner — live continuous-stream scanner for deck-tracking mode.
 * Detects a card in the camera feed client-side (jscanify/OpenCV.js, see
 * utils/cardDetection.js), and once it's been held steady for
 * REQUIRED_STABLE_FRAMES ticks, captures it and sends exactly one image to
 * the existing /api/cards/recognize endpoint — no polling, no repeated
 * calls per card. A confident match auto-saves through the same
 * confirmCard() path a manual tap already used before this feature existed
 * (not a new/parallel save path); an ambiguous one falls back to the
 * existing tap-to-confirm candidate list unchanged. If the camera can't be
 * used at all (denied, unavailable, non-secure context), falls back to the
 * original file-input "Take Photo" flow, also unchanged.
 *
 * Props: isOpen, onClose, onConfirm(candidateCard), deckInstanceId — the
 * pipeline tried per card is OCR (free) -> deck-scoped pHash/number/name
 * match against ONLY deckInstanceId's own still-missing cards (free, see
 * matchDeckImage in api/client.js) -> recognizeCard (paid, Gemini) as the
 * last resort. deckInstanceId is required for the free tiers to run at
 * all — without it (shouldn't happen; DeckDetail.jsx always has one) this
 * falls straight through to the paid call every time. Renders as its own
 * full-viewport portal (matching CardScanner.jsx), not the Modal/Sheet
 * wrapper this component used before — a live camera feed doesn't fit a
 * container built for scrollable forms.
 */
export default function DeckCardScanner({ isOpen, onClose, onConfirm, deckInstanceId }) {
  const { t } = useSettings()

  const manualFileRef = useRef()
  const detectionCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const captureCanvasRef = useRef(null)
  const stabilityTrackerRef = useRef(createStabilityTracker({
    requiredConsecutiveFrames: REQUIRED_STABLE_FRAMES,
    toleranceProportion: STABILITY_TOLERANCE_PROPORTION,
  }))
  const tickInFlightRef = useRef(false)
  const cameraFallbackLockedRef = useRef(false)
  const timersRef = useRef([])
  // Set to the just-captured quad (detection-frame coordinates) right after
  // a successful auto-save; cleared the first time a detection tick sees
  // either no card at all, or a quad that has moved away from the captured
  // one. Without this, a still-sitting card the user hasn't physically
  // moved away yet gets auto-detected as stable again within a few hundred
  // ms of returning to 'hunting' — a real, observed redundant re-scan of an
  // already-saved card (see build step 8/11 real-device notes).
  //
  // Comparing against the captured quad's position (not just "is any quad
  // present") matters because a fast card swap — the next card slid in
  // before the previous one is fully out of frame — never produces a
  // literal empty frame. With a plain boolean cleared only on "no quad",
  // that left this permanently blocking capture until the scanner was
  // closed and reopened (real-device report: works fine for the first few
  // cards, then silently stops auto-capturing entirely).
  const awaitingCardRemovalRef = useRef(null)
  // The detection-frame quad a capture was just attempted against — read by
  // enterSuccessCooldown to seed awaitingCardRemovalRef above. Kept
  // separate from the native-resolution quad captureAndRecognize works
  // with (see scaleQuad calls below); this one stays in the same
  // detection-frame coordinate space the tick loop's own comparisons use.
  const pendingCaptureQuadRef = useRef(null)
  // Most recent quad the tick loop actually saw, refreshed every tick and
  // cleared the moment a tick finds nothing — read by handleScanNow so the
  // manual "Scan now" button can fire off the same quad the overlay is
  // currently drawing, without waiting for REQUIRED_STABLE_FRAMES of hold
  // time. Detection-frame coordinates, same space as pendingCaptureQuadRef.
  const latestQuadRef = useRef(null)

  // hunting | processing | ambiguous | success | error | cameraDenied
  const [phase, setPhase] = useState('hunting')
  const [videoAspect, setVideoAspect] = useState(3 / 4)
  const [showCheckmark, setShowCheckmark] = useState(false)
  // 'counted' | 'already_complete' | 'not_in_deck' — see enterSuccessCooldown.
  const [checkmarkStatus, setCheckmarkStatus] = useState('counted')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [confirmError, setConfirmError] = useState(null)
  const [confirmingKey, setConfirmingKey] = useState(null)
  // Visible diagnostic readout, not devtools-only — this app has no console
  // access on a phone. Mirrors detectionStatus (opencv.js/jscanify load
  // state) plus the last error from the detection loop itself, which
  // previously ran unhandled: a rejected detectCardQuad() call (e.g. a CSP
  // block on WASM compilation) just silently retried forever with the
  // camera visibly live and nothing else ever happening.
  const [debugInfo, setDebugInfo] = useState({ tickCount: 0, tickError: null, ocrName: undefined, ocrNumber: undefined })
  // Recognition (Gemini identify + visual-match, see recognize.py) can take
  // well over a minute under real API load with the backend's own retries —
  // measured 89s in practice. A static "Identifying card..." spinner is
  // indistinguishable from hung at that duration; a running clock isn't.
  const [processingSeconds, setProcessingSeconds] = useState(0)
  const processingTimerRef = useRef(null)
  // Set at the start of any processing-phase network call, cleared once it
  // settles — cancelProcessing() aborts whichever request is currently
  // live. A real AbortController (not just a "please ignore the result"
  // flag) so a cancelled request actually stops, instead of continuing to
  // tie up the connection/backend for a result nobody wants anymore.
  const abortControllerRef = useRef(null)

  const cameraActive = isOpen && phase !== 'cameraDenied'
  const { videoRef, status: cameraStatus } = useCameraStream({ active: cameraActive })

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
  }

  // Re-attempt camera access (and drop any stale result from a previous
  // session) every time the scanner is freshly opened — a user who denied
  // access once, or changed their browser's permission since, gets another
  // chance rather than being stuck on the fallback for good.
  useEffect(() => {
    if (!isOpen) return
    cameraFallbackLockedRef.current = false
    awaitingCardRemovalRef.current = null
    latestQuadRef.current = null
    setResult(null)
    setError(null)
    setConfirmError(null)
    stabilityTrackerRef.current.reset()
    setPhase('hunting')
  }, [isOpen])

  // Preload OpenCV.js/jscanify as soon as the scanner opens, so the first
  // stable hold doesn't stall on a ~10MB download.
  useEffect(() => {
    if (isOpen) preloadCardDetection()
  }, [isOpen])

  useEffect(() => {
    if (cameraStatus === 'denied' || cameraStatus === 'unavailable') {
      cameraFallbackLockedRef.current = true
      setPhase('cameraDenied')
    }
  }, [cameraStatus])

  useEffect(() => () => {
    clearTimers()
    clearInterval(processingTimerRef.current)
    abortControllerRef.current?.abort()
  }, [])

  // deckScanStatus (see backend services/deck_progress.py's SCAN_* constants,
  // round-tripped through onConfirm's response below) picks which overlay
  // shows: the usual green checkmark for "counted", or a yellow warning for
  // a card that didn't move deck progress at all — not in this deck's
  // template, or already at its expected quantity. Silently treating those
  // the same as a real match (the previous behavior) meant a mis-scan or a
  // duplicate looked identical to a correctly-tracked card.
  const enterSuccessCooldown = (deckScanStatus = 'counted') => {
    setResult(null)
    setError(null)
    setPhase('success')
    setCheckmarkStatus(deckScanStatus)
    setShowCheckmark(true)
    awaitingCardRemovalRef.current = pendingCaptureQuadRef.current
    timersRef.current.push(setTimeout(() => setShowCheckmark(false), CHECKMARK_DURATION_MS))
    timersRef.current.push(setTimeout(() => {
      stabilityTrackerRef.current.reset()
      setPhase('hunting')
    }, CHECKMARK_DURATION_MS + COOLDOWN_AFTER_CHECKMARK_MS))
  }

  const resetForNextCard = () => {
    clearTimers()
    setResult(null)
    setError(null)
    setConfirmError(null)
    setConfirmingKey(null)
    stabilityTrackerRef.current.reset()
    setPhase(cameraFallbackLockedRef.current ? 'cameraDenied' : 'hunting')
  }

  const handleClose = () => {
    clearTimers()
    onClose?.()
  }

  // Shared by every confirm path — auto-save on a confident live detection,
  // a manual tap in the ambiguous candidate list, and a tap from the
  // camera-denied fallback's own candidate list. Awaits the caller's
  // confirm action (adding the card to the deck) before moving on; a
  // failure stays visible via confirmError rather than silently resetting.
  // Returns whether the save succeeded, so callers with no picker of their
  // own (the auto-save path) know whether to fall back to showing one.
  // isAutoSave is threaded through to onConfirm so DeckDetail.jsx's own
  // success handler can show an Undo-capable toast for auto-saves instead
  // of stacking it on top of the existing plain one (see DeckDetail.jsx).
  // traceId (from recognizeCard()'s response, only present when the user
  // has scan diagnostics enabled) rides along the same way, so an eventual
  // undo can be correlated back to the scan trace it's reversing.
  const confirmCard = async (candidate, key, isAutoSave = false, traceId = null) => {
    setConfirmingKey(key)
    setConfirmError(null)
    try {
      const response = await onConfirm(candidate, { isAutoSave, traceId })
      // The fallback path skips the checkmark theater — just clear back to
      // the ready-to-scan-next state (resetForNextCard already routes to
      // 'cameraDenied' vs 'hunting' correctly based on the same lock).
      if (cameraFallbackLockedRef.current) {
        resetForNextCard()
      } else {
        enterSuccessCooldown(response?.data?.deck_scan_status)
      }
      return true
    } catch {
      setConfirmError(t('decks.scan.confirmFailed'))
      return false
    } finally {
      setConfirmingKey(null)
    }
  }

  // Free tiers, tried before the paid recognizeCard() call below: OCR
  // (client-side, may find nothing — that's fine, see below), then a
  // deck-scoped pHash/number/name match against ONLY deckInstanceId's own
  // still-missing cards (matchDeckImage — never a broad TCGdex search).
  // Never throws — any failure here just means "fall back to the paid
  // path for this one card," not a hard error for the capture. A
  // not-confident deck-match result is deliberately discarded in favor of
  // a fresh paid-call attempt rather than shown as-is (the paid call is
  // the fallback for cards the free tiers can't confidently resolve, not
  // a second-tier candidate list of its own).
  const runOcr = async (nativeFrameSource, quad, width, height) => {
    const ocrCanvas = await extractCard(nativeFrameSource, width, height, quad)
    if (!ocrCanvas) return null
    return recognizeCardText(ocrCanvas)
  }

  const tryOcrMatch = async (nativeFrameSource, quad, blob, signal) => {
    let ocrFields = null
    try {
      ocrFields = await runOcr(nativeFrameSource, quad, OCR_CROP_WIDTH, OCR_CROP_HEIGHT)
    } catch (err) {
      // A user-cancelled request must propagate all the way out to
      // captureAndRecognize, not be swallowed here as "OCR failed, fall
      // back to the next tier" — that would silently keep going (and
      // eventually fire the paid call) after the user explicitly asked to
      // stop.
      if (signal.aborted) throw err
      // Real-device finding: a Tesseract worker.recognize() call rejected
      // outright (not just "found nothing") on the larger OCR-only crop —
      // unconfirmed whether the size itself is why (could as easily be the
      // tab backgrounding mid-recognition). Retry once at the smaller,
      // original crop size — a genuinely different, lighter-weight attempt,
      // not a blind repeat — before falling through to a pure image match
      // with no OCR hints at all (still worth trying: pHash alone can
      // resolve a card with zero OCR input, see matchDeckImage below).
      setDebugInfo((d) => ({ ...d, tickError: `ocr(large): ${describeError(err)}` }))
      try {
        ocrFields = await runOcr(nativeFrameSource, quad, CARD_CROP_WIDTH, CARD_CROP_HEIGHT)
      } catch (err2) {
        if (signal.aborted) throw err2
        setDebugInfo((d) => ({
          ...d, ocrName: null, ocrNumber: null, ocrRawText: '', ocrWords: [],
          tickError: `ocr: ${describeError(err2)}`,
        }))
      }
    }

    if (ocrFields) {
      // Visible, not just inferred from "the paid call ran anyway" — the
      // only way to tell "OCR found nothing" apart from "OCR found
      // something but the deck match wasn't confident" without this was
      // reading server logs by hand (see the real-device Wattrel case).
      setDebugInfo((d) => ({
        ...d,
        ocrName: ocrFields.name,
        ocrNumber: ocrFields.number_local,
        ocrRawText: lastOcrRawText.value,
        // Shows every recognized word's own confidence/position, including
        // ones pickCardName rejected — the only way to tell "nothing scored
        // high enough" apart from "the name band/confidence floor need
        // retuning" (see cardOcr.js's NAME_BAND_FRACTION/MIN_NAME_CONFIDENCE).
        ocrWords: lastOcrWords.value,
      }))
    }

    // deckInstanceId missing shouldn't happen (DeckDetail.jsx always
    // passes one) — defensive, not a real expected path.
    if (!deckInstanceId) return null

    try {
      return await matchDeckImage(
        deckInstanceId, blob,
        { numberLocal: ocrFields?.number_local, name: ocrFields?.name },
        'live_auto_scan',
        signal,
      )
    } catch (err) {
      if (signal.aborted) throw err
      setDebugInfo((d) => ({ ...d, tickError: `deck-match: ${describeError(err)}` }))
      return null
    }
  }

  const captureAndRecognize = async (nativeFrameSource, quad) => {
    setPhase('processing')
    setProcessingSeconds(0)
    processingTimerRef.current = setInterval(() => setProcessingSeconds((s) => s + 1), 1000)
    // Deliberately not preloaded upfront alongside OpenCV.js (see
    // cardOcr.js / frontend/public/tesseract/VENDORED.md) — only starts
    // downloading once a card is actually being captured, so it doesn't
    // double the initial scanner-open payload for a feature that only
    // pays off after detection already succeeded.
    preloadCardOcr()
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const cropCanvas = await extractCard(nativeFrameSource, CARD_CROP_WIDTH, CARD_CROP_HEIGHT, quad)
      if (!cropCanvas) throw new Error('extract-failed')
      const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob) throw new Error('capture-failed')

      let data = await tryOcrMatch(nativeFrameSource, quad, blob, controller.signal)
      if (!data?._identity_confident) {
        data = await recognizeCard(blob, 'live_auto_scan', controller.signal)
      }
      const topCandidate = data?.matches?.[0]

      if (data?._identity_confident && topCandidate) {
        const saved = await confirmCard(topCandidate, topCandidate.id || 'auto', true, data.trace_id)
        if (!saved) {
          setResult(data)
          setPhase('ambiguous')
        }
      } else {
        setResult(data)
        setPhase('ambiguous')
      }
    } catch (err) {
      // User-initiated (cancelProcessing) — go straight back to hunting,
      // not the error banner; this isn't a failure, it's what was asked
      // for.
      if (controller.signal.aborted) {
        resetForNextCard()
        return
      }
      setError(t('decks.scan.failed'))
      setDebugInfo((d) => ({ ...d, tickError: `capture: ${err?.message || err}` }))
      setPhase('error')
    } finally {
      clearInterval(processingTimerRef.current)
      if (abortControllerRef.current === controller) abortControllerRef.current = null
    }
  }

  // Aborts whichever processing-phase request is currently in flight (the
  // free deck-match tier, or the paid recognizeCard fallback) — see
  // abortControllerRef's own comment for why this is a real
  // AbortController, not just a "please ignore the eventual result" flag.
  const cancelProcessing = () => {
    abortControllerRef.current?.abort()
  }

  // Manual override for when the auto-capture is taking too long to kick in
  // (quad detected but not holding steady long enough, or REQUIRED_STABLE_
  // FRAMES just feels slow to an impatient user who can see the card is
  // sitting right there). Fires the same captureAndRecognize path the tick
  // loop's own readyToCapture branch uses, seeded with whatever quad the
  // tick loop most recently saw (latestQuadRef) rather than waiting for a
  // fresh stable streak. If no quad has been seen at all (e.g. detection is
  // struggling with lighting/angle), falls back to the full video frame —
  // still worth sending; recognizeCard doesn't require a perfectly
  // perspective-corrected crop, just a photo of the card.
  const handleScanNow = async () => {
    if (phase !== 'hunting' || cameraStatus !== 'streaming') return
    if (tickInFlightRef.current) return
    const video = videoRef.current
    const captureCanvas = captureCanvasRef.current
    if (!video || !captureCanvas || video.readyState < 2 || !video.videoWidth) return

    tickInFlightRef.current = true
    try {
      const seen = latestQuadRef.current
      const nativeQuad = seen
        ? scaleQuad(seen.quad, video.videoWidth / seen.detectionWidth, video.videoHeight / seen.detectionHeight)
        : {
          topLeftCorner: { x: 0, y: 0 },
          topRightCorner: { x: video.videoWidth, y: 0 },
          bottomLeftCorner: { x: 0, y: video.videoHeight },
          bottomRightCorner: { x: video.videoWidth, y: video.videoHeight },
        }

      captureCanvas.width = video.videoWidth
      captureCanvas.height = video.videoHeight
      captureCanvas.getContext('2d').drawImage(video, 0, 0)
      pendingCaptureQuadRef.current = seen?.quad || null
      await captureAndRecognize(captureCanvas, nativeQuad)
    } finally {
      tickInFlightRef.current = false
    }
  }

  // ---- live detection loop: only runs while actively hunting ----
  useEffect(() => {
    if (phase !== 'hunting' || cameraStatus !== 'streaming') return undefined

    const intervalId = setInterval(async () => {
      if (tickInFlightRef.current) return
      const video = videoRef.current
      const detectionCanvas = detectionCanvasRef.current
      const overlayCanvas = overlayCanvasRef.current
      if (!video || !detectionCanvas || !overlayCanvas || video.readyState < 2 || !video.videoWidth) return

      tickInFlightRef.current = true
      try {
        setDebugInfo((d) => ({
          tickCount: d.tickCount + 1,
          tickError: null,
          libState: detectionStatus.state,
          libError: detectionStatus.error,
        }))
        const scale = Math.min(1, DETECTION_MAX_WIDTH / video.videoWidth)
        const detectionWidth = Math.round(video.videoWidth * scale)
        const detectionHeight = Math.round(video.videoHeight * scale)
        if (detectionCanvas.width !== detectionWidth || detectionCanvas.height !== detectionHeight) {
          detectionCanvas.width = detectionWidth
          detectionCanvas.height = detectionHeight
        }
        if (overlayCanvas.width !== video.videoWidth || overlayCanvas.height !== video.videoHeight) {
          overlayCanvas.width = video.videoWidth
          overlayCanvas.height = video.videoHeight
          setVideoAspect(video.videoWidth / video.videoHeight || 3 / 4)
        }

        detectionCanvas.getContext('2d').drawImage(video, 0, 0, detectionWidth, detectionHeight)

        const quad = await detectCardQuad(detectionCanvas)
        latestQuadRef.current = quad ? { quad, detectionWidth, detectionHeight } : null
        if (!quad) {
          awaitingCardRemovalRef.current = null
        } else if (
          awaitingCardRemovalRef.current
          && !quadsAreStable(awaitingCardRemovalRef.current, quad, detectionWidth, detectionHeight, STABILITY_TOLERANCE_PROPORTION)
        ) {
          awaitingCardRemovalRef.current = null
        }
        const { consecutiveStableFrames, readyToCapture } = stabilityTrackerRef.current.observe(
          quad, detectionWidth, detectionHeight,
        )

        const overlayScaleX = overlayCanvas.width / detectionWidth
        const overlayScaleY = overlayCanvas.height / detectionHeight
        drawOverlay(
          overlayCanvas,
          quad && scaleQuad(quad, overlayScaleX, overlayScaleY),
          consecutiveStableFrames / REQUIRED_STABLE_FRAMES,
        )

        if (readyToCapture && quad && !awaitingCardRemovalRef.current) {
          const captureCanvas = captureCanvasRef.current
          captureCanvas.width = video.videoWidth
          captureCanvas.height = video.videoHeight
          captureCanvas.getContext('2d').drawImage(video, 0, 0)
          const nativeQuad = scaleQuad(quad, video.videoWidth / detectionWidth, video.videoHeight / detectionHeight)
          pendingCaptureQuadRef.current = quad
          await captureAndRecognize(captureCanvas, nativeQuad)
        }
      } catch (err) {
        setDebugInfo((d) => ({ ...d, tickError: err?.message || String(err), libState: detectionStatus.state, libError: detectionStatus.error }))
      } finally {
        tickInFlightRef.current = false
      }
    }, DETECTION_INTERVAL_MS)

    return () => clearInterval(intervalId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cameraStatus])

  // Freeze the visible frame instead of letting it keep playing behind the
  // spinner/candidate list/checkmark — matches the plan's "freeze + crop"
  // flow rather than a live feed still moving under a result the user is
  // looking at.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (phase === 'hunting') {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [phase, videoRef])

  const handleManualFile = async (file) => {
    if (!file) return
    setResult(null)
    setError(null)
    setConfirmError(null)
    setPhase('processing')
    setProcessingSeconds(0)
    processingTimerRef.current = setInterval(() => setProcessingSeconds((s) => s + 1), 1000)
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const data = await recognizeCard(file, 'manual', controller.signal)
      setResult(data)
      setPhase('ambiguous')
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase('cameraDenied')
        return
      }
      setError(err?.response?.data?.detail || t('decks.scan.failed'))
      setPhase('cameraDenied')
    } finally {
      clearInterval(processingTimerRef.current)
      if (abortControllerRef.current === controller) abortControllerRef.current = null
    }
  }

  if (!isOpen) return null

  const matches = (result?.matches || []).slice(0, 6)

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col"
      style={{ background: 'rgba(0,0,0,0.95)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-2 flex-shrink-0">
        <p className="text-[10px] text-text-muted uppercase tracking-[0.2em]">{t('decks.scan.title')}</p>
        <button
          onClick={handleClose}
          aria-label={t('common.close')}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.08)' }}
        >
          <X size={18} className="text-text-muted" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {phase === 'cameraDenied' && (
          <div className="flex flex-col items-center gap-5 pt-4">
            <p className="text-sm text-text-secondary text-center">{t('decks.scan.cameraUnavailable')}</p>
            <input
              ref={manualFileRef}
              type="file"
              accept={SCANNER_IMAGE_ACCEPT}
              capture="environment"
              className="hidden"
              onChange={(event) => {
                handleManualFile(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => manualFileRef.current?.click()}
              className="btn-primary w-full max-w-xs flex items-center justify-center gap-2 py-4"
            >
              <Camera size={18} /> {t('decks.scan.takePhoto')}
            </button>
            {error && (
              <div className={`${ERROR_BANNER_CLASS} w-full max-w-xs`}>
                <p className="text-sm text-brand-red">{error}</p>
              </div>
            )}
          </div>
        )}

        {(phase === 'hunting' || phase === 'processing' || phase === 'success' || phase === 'error') && (
          <div className="flex flex-col items-center gap-4 pt-2">
            <div className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: videoAspect }}>
              <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-contain" />
              <canvas ref={overlayCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
              <canvas ref={detectionCanvasRef} className="hidden" aria-hidden="true" />
              <canvas ref={captureCanvasRef} className="hidden" aria-hidden="true" />

              {phase === 'processing' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
                  <Loader2 size={28} className="animate-spin text-brand-red" />
                  <p className="text-sm text-white">
                    {t('decks.scan.identifying')}
                    {processingSeconds > 0 && ` (${processingSeconds}s)`}
                  </p>
                  {/* Card recognition retries through transient upstream
                      failures (see recognizeCard's timeout comment in
                      api/client.js) — past ~15s this is very likely still
                      working, not stuck, so say so rather than leaving a
                      bare spinner that looks identical to hung. */}
                  {processingSeconds >= 15 && (
                    <p className="text-sm text-white/90 max-w-[220px] text-center">
                      Still working — the recognition service may be slow right now.
                    </p>
                  )}
                  {/* Visible from the moment processing starts, not gated
                      behind the "still working" delay — a real request in
                      flight, so it should always be possible to back out.
                      btn-ghost's text-text-secondary assumes a light
                      background — unreadable on this dark overlay, same
                      issue already fixed for the text above it. Styled
                      explicitly instead of reusing that class. */}
                  <button
                    type="button"
                    onClick={cancelProcessing}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white border border-white/30 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 transition-colors"
                  >
                    {t('decks.scan.cancel')}
                  </button>
                </div>
              )}

              {phase === 'success' && showCheckmark && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60">
                  {checkmarkStatus === 'counted' ? (
                    <span
                      className="inline-flex items-center justify-center rounded-full border border-green/40 bg-green/90 p-4 text-white shadow-lg"
                      aria-label={t('decks.scan.captured')}
                    >
                      <Check size={32} strokeWidth={3} aria-hidden />
                    </span>
                  ) : (
                    // Distinct from the green checkmark above (both the icon
                    // and an explicit caption, not just a color swap) — a
                    // card that didn't actually move deck progress (not
                    // part of this deck's template, or already at its
                    // expected quantity) must not look like a normal
                    // successful match.
                    <span
                      className="inline-flex items-center justify-center rounded-full border border-yellow/50 bg-yellow/90 p-4 text-black shadow-lg"
                      aria-label={t(checkmarkStatus === 'not_in_deck' ? 'decks.scan.notInDeck' : 'decks.scan.alreadyComplete')}
                    >
                      <AlertTriangle size={32} strokeWidth={2.5} aria-hidden />
                    </span>
                  )}
                  {checkmarkStatus !== 'counted' && (
                    <p className="text-sm font-semibold text-yellow max-w-[220px] text-center">
                      {t(checkmarkStatus === 'not_in_deck' ? 'decks.scan.notInDeck' : 'decks.scan.alreadyComplete')}
                    </p>
                  )}
                </div>
              )}
            </div>

            {phase === 'hunting' && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-text-muted text-center max-w-xs">{t('decks.scan.liveHint')}</p>
                <button
                  type="button"
                  onClick={handleScanNow}
                  className="btn-ghost text-sm"
                >
                  {t('decks.scan.scanNow')}
                </button>
              </div>
            )}

            {/* Temporary on-device diagnostic readout — no devtools access on
                a phone, and the detection loop previously failed completely
                silently (see cardDetection.js's detectionStatus comment).
                Widened to match the video's own max-w-sm (was max-w-xs) and
                given longer text/word slices below — freed up by dropping
                the header subtitle line, and this is the thing the user is
                actually watching while positioning a card. */}
            <div className="text-sm font-mono text-white/90 text-center max-w-sm leading-relaxed break-words">
              cam:{cameraStatus} lib:{debugInfo.libState || 'idle'} ticks:{debugInfo.tickCount}
              {debugInfo.libError && <><br />lib error: {debugInfo.libError}</>}
              {debugInfo.ocrName !== undefined && (
                <><br />ocr name:{debugInfo.ocrName ?? '(none)'} number:{debugInfo.ocrNumber ?? '(none)'}</>
              )}
              {debugInfo.ocrRawText !== undefined && (
                <><br />ocr raw:{debugInfo.ocrRawText.trim()
                  ? JSON.stringify(debugInfo.ocrRawText.replace(/\s+/g, ' ').trim().slice(0, 220))
                  : '(empty)'}</>
              )}
              {debugInfo.ocrWords !== undefined && (
                <><br />ocr words:{debugInfo.ocrWords.length === 0
                  ? '(none)'
                  : debugInfo.ocrWords
                    // Highest-confidence first — the ones pickCardName
                    // would have preferred if position let it through.
                    // A real card produced more than fit in the earlier
                    // line-level view's smaller slice, hiding the very
                    // word that mattered — 16 gives more headroom (wider
                    // readout now, see the container's own comment above).
                    .slice().sort((a, b) => b.confidence - a.confidence).slice(0, 16)
                    .map((w) => `"${w.text.slice(0, 15)}"@y${w.y0}(${w.confidence})`)
                    .join(' ')}</>
              )}
              {debugInfo.tickError && <><br />tick error: {debugInfo.tickError}</>}
            </div>

            {phase === 'error' && (
              <div className={`${ERROR_BANNER_CLASS} w-full max-w-sm`}>
                <p className="text-sm text-brand-red">{error}</p>
                <button onClick={resetForNextCard} className="btn-ghost mt-3 mx-auto text-sm">
                  {t('decks.scan.tryAgain')}
                </button>
              </div>
            )}
          </div>
        )}

        {phase === 'ambiguous' && result && (
          <div className="space-y-3">
            {confirmError && (
              <div className="rounded-lg border border-brand-red/30 bg-brand-red/5 px-3 py-2 text-center">
                <p className="text-sm text-brand-red">{confirmError}</p>
              </div>
            )}
            {matches.length === 0 && (
              <div className="text-center py-6 space-y-3">
                <p className="text-sm text-text-secondary">{t('decks.scan.noMatch')}</p>
                <button onClick={resetForNextCard} className="btn-ghost mx-auto text-sm">{t('decks.scan.tryAgain')}</button>
              </div>
            )}
            {matches.map((candidate, i) => {
              const key = candidate.id || i
              const isConfirmingThis = confirmingKey === key
              return (
                <button
                  key={key}
                  type="button"
                  disabled={confirmingKey != null}
                  onClick={() => confirmCard(candidate, key, false, result.trace_id)}
                  className="w-full flex items-center gap-3 rounded-xl border border-border bg-bg-card p-3 text-left hover:border-brand-red/40 hover:bg-brand-red/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/70 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <img
                    src={resolveCardImageUrl(candidate, 'small')}
                    alt={candidate.name}
                    className="h-16 w-auto rounded-md flex-shrink-0"
                    loading="lazy"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-primary truncate">{candidate.name}</p>
                    <p className="text-xs text-text-muted truncate">
                      {candidate.set?.name}{candidate.number ? ` · #${candidate.number}` : ''}
                    </p>
                    {i === 0 && result._identity_confident && (
                      <span className="badge badge-green mt-1 inline-block">{t('decks.scan.bestMatch')}</span>
                    )}
                  </div>
                  {isConfirmingThis
                    ? <Loader2 size={18} className="flex-shrink-0 animate-spin text-brand-red" />
                    : <Check size={18} className="flex-shrink-0 text-text-muted" />}
                </button>
              )
            })}
            {matches.length > 0 && (
              <button onClick={resetForNextCard} disabled={confirmingKey != null} className="btn-ghost w-full text-sm disabled:cursor-not-allowed disabled:opacity-50">
                {t('decks.scan.scanAnother')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
