import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, Check, Loader2, X } from 'lucide-react'
import { matchCardText, recognizeCard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import { useCameraStream } from '../hooks/useCameraStream'
import { detectCardQuad, detectionStatus, extractCard, preloadCardDetection } from '../utils/cardDetection'
import { lastOcrRawText, lastOcrWords, preloadCardOcr, recognizeCardText } from '../utils/cardOcr'
import { createStabilityTracker } from '../utils/quadStability'

const DETECTION_INTERVAL_MS = 180
const REQUIRED_STABLE_FRAMES = 5
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
 * Props: isOpen, onClose, onConfirm(candidateCard) — same external contract
 * as before; DeckDetail.jsx needs no changes. Renders as its own
 * full-viewport portal (matching CardScanner.jsx), not the Modal/Sheet
 * wrapper this component used before — a live camera feed doesn't fit a
 * container built for scrollable forms.
 */
export default function DeckCardScanner({ isOpen, onClose, onConfirm }) {
  const { t } = useSettings()

  const manualFileRef = useRef()
  const detectionCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const captureCanvasRef = useRef(null)
  const stabilityTrackerRef = useRef(createStabilityTracker({ requiredConsecutiveFrames: REQUIRED_STABLE_FRAMES }))
  const tickInFlightRef = useRef(false)
  const cameraFallbackLockedRef = useRef(false)
  const timersRef = useRef([])
  // Set right after a successful auto-save; cleared the first time a
  // detection tick sees no card at all. Without this, a still-sitting card
  // the user hasn't physically moved away yet gets auto-detected as stable
  // again within a few hundred ms of returning to 'hunting' — a real,
  // observed redundant re-scan of an already-saved card (see build step 8/11
  // real-device notes), not a hypothetical.
  const awaitingCardRemovalRef = useRef(false)

  // hunting | processing | ambiguous | success | error | cameraDenied
  const [phase, setPhase] = useState('hunting')
  const [videoAspect, setVideoAspect] = useState(3 / 4)
  const [showCheckmark, setShowCheckmark] = useState(false)
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
    awaitingCardRemovalRef.current = false
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
  }, [])

  const enterSuccessCooldown = () => {
    setResult(null)
    setError(null)
    setPhase('success')
    setShowCheckmark(true)
    awaitingCardRemovalRef.current = true
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
      await onConfirm(candidate, { isAutoSave, traceId })
      // The fallback path skips the checkmark theater — just clear back to
      // the ready-to-scan-next state (resetForNextCard already routes to
      // 'cameraDenied' vs 'hunting' correctly based on the same lock).
      if (cameraFallbackLockedRef.current) {
        resetForNextCard()
      } else {
        enterSuccessCooldown()
      }
      return true
    } catch {
      setConfirmError(t('decks.scan.confirmFailed'))
      return false
    } finally {
      setConfirmingKey(null)
    }
  }

  // Phase 2 (docs/plans/live-card-scanner.md): the free OCR+metadata path,
  // tried before the paid recognizeCard() call below. Never throws — any
  // failure here (OCR itself, or the match-text call) just means "fall back
  // to the paid path for this one card," not a hard error for the capture.
  // A not-confident OCR result is deliberately discarded in favor of a
  // fresh paid-call attempt rather than shown as-is (see the plan's Phase 2
  // "Net effect": the paid call is the fallback for cards OCR can't
  // confidently resolve, not a second-tier candidate list of its own).
  const runOcr = async (nativeFrameSource, quad, width, height) => {
    const ocrCanvas = await extractCard(nativeFrameSource, width, height, quad)
    if (!ocrCanvas) return null
    return recognizeCardText(ocrCanvas)
  }

  const tryOcrMatch = async (nativeFrameSource, quad, blob) => {
    let ocrFields
    try {
      ocrFields = await runOcr(nativeFrameSource, quad, OCR_CROP_WIDTH, OCR_CROP_HEIGHT)
    } catch (err) {
      // Real-device finding: a Tesseract worker.recognize() call rejected
      // outright (not just "found nothing") on the larger OCR-only crop —
      // unconfirmed whether the size itself is why (could as easily be the
      // tab backgrounding mid-recognition). Retry once at the smaller,
      // original crop size — a genuinely different, lighter-weight attempt,
      // not a blind repeat — before giving up on OCR for this card.
      setDebugInfo((d) => ({ ...d, tickError: `ocr(large): ${describeError(err)}` }))
      try {
        ocrFields = await runOcr(nativeFrameSource, quad, CARD_CROP_WIDTH, CARD_CROP_HEIGHT)
      } catch (err2) {
        setDebugInfo((d) => ({
          ...d, ocrName: null, ocrNumber: null, ocrRawText: '',
          tickError: `ocr: ${describeError(err2)}`,
        }))
        return null
      }
    }
    if (!ocrFields) return null
    // Visible, not just inferred from "the paid call ran anyway" — the
    // only way to tell "OCR found nothing" apart from "OCR found
    // something but match-text wasn't confident" without this was
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
    if (!ocrFields.name) return null
    try {
      return await matchCardText(ocrFields, blob, 'live_auto_scan')
    } catch (err) {
      setDebugInfo((d) => ({ ...d, tickError: `match-text: ${describeError(err)}` }))
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
    try {
      const cropCanvas = await extractCard(nativeFrameSource, CARD_CROP_WIDTH, CARD_CROP_HEIGHT, quad)
      if (!cropCanvas) throw new Error('extract-failed')
      const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob) throw new Error('capture-failed')

      let data = await tryOcrMatch(nativeFrameSource, quad, blob)
      if (!data?._identity_confident) {
        data = await recognizeCard(blob, 'live_auto_scan')
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
      setError(t('decks.scan.failed'))
      setDebugInfo((d) => ({ ...d, tickError: `capture: ${err?.message || err}` }))
      setPhase('error')
    } finally {
      clearInterval(processingTimerRef.current)
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
        if (!quad) awaitingCardRemovalRef.current = false
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
    try {
      const data = await recognizeCard(file, 'manual')
      setResult(data)
      setPhase('ambiguous')
    } catch (err) {
      setError(err?.response?.data?.detail || t('decks.scan.failed'))
      setPhase('cameraDenied')
    }
  }

  if (!isOpen) return null

  const matches = (result?.matches || []).slice(0, 6)

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col"
      style={{ background: 'rgba(0,0,0,0.95)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div className="flex items-center justify-between px-4 pt-6 pb-4 flex-shrink-0">
        <div>
          <p className="text-[10px] text-text-muted uppercase tracking-[0.2em]">{t('decks.scan.title')}</p>
          <h2 className="text-lg font-black text-white">{t('decks.scan.subtitle')}</h2>
        </div>
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
                    <p className="text-xs text-text-muted max-w-[220px] text-center">
                      Still working — the recognition service may be slow right now.
                    </p>
                  )}
                </div>
              )}

              {phase === 'success' && showCheckmark && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <span
                    className="inline-flex items-center justify-center rounded-full border border-green/40 bg-green/90 p-4 text-white shadow-lg"
                    aria-label={t('decks.scan.captured')}
                  >
                    <Check size={32} strokeWidth={3} aria-hidden />
                  </span>
                </div>
              )}
            </div>

            {phase === 'hunting' && (
              <p className="text-xs text-text-muted text-center max-w-xs">{t('decks.scan.liveHint')}</p>
            )}

            {/* Temporary on-device diagnostic readout — no devtools access on
                a phone, and the detection loop previously failed completely
                silently (see cardDetection.js's detectionStatus comment). */}
            <div className="text-[10px] font-mono text-text-muted/60 text-center max-w-xs leading-relaxed break-words">
              cam:{cameraStatus} lib:{debugInfo.libState || 'idle'} ticks:{debugInfo.tickCount}
              {debugInfo.libError && <><br />lib error: {debugInfo.libError}</>}
              {debugInfo.ocrName !== undefined && (
                <><br />ocr name:{debugInfo.ocrName ?? '(none)'} number:{debugInfo.ocrNumber ?? '(none)'}</>
              )}
              {debugInfo.ocrRawText !== undefined && (
                <><br />ocr raw:{debugInfo.ocrRawText.trim()
                  ? JSON.stringify(debugInfo.ocrRawText.replace(/\s+/g, ' ').trim().slice(0, 150))
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
                    // word that mattered — 12 gives more headroom.
                    .slice().sort((a, b) => b.confidence - a.confidence).slice(0, 12)
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
