import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Camera, Check, Loader2, Plus, X } from 'lucide-react'
import { matchDeckImage, recognizeCard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import { useCameraStream } from '../hooks/useCameraStream'
import { detectCardQuad, detectionStatus, extractCard, preloadCardDetection } from '../utils/cardDetection'
import { lastOcrRawText, lastOcrWords, preloadCardOcr, recognizeCardText, recognizeNumberRegion } from '../utils/cardOcr'
import { createStabilityTracker, quadsAreStable } from '../utils/quadStability'
import { computeNumberBandRect } from '../utils/numberBand'

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
// A warning (not in this deck / already have enough) needs real reading
// time — the green checkmark doesn't, it's just a "yep, got it" tick. Also
// dismissible early with a tap (see the warning overlay's onClick below),
// so a longer default here doesn't cost anything when the user's ready to
// move on sooner.
const WARNING_DURATION_MS = 4000
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
// Phase 3's Path B (docs/plans/live-card-scanner.md): a throttled, number-
// only OCR pass independent of Path A's quad-stability capture above —
// runs whether or not a quad is currently detected, so zooming in past the
// card's edges still gets a live reading. Reasoned starting points, not
// empirically calibrated against real devices yet — same caveat every
// other tuning constant on this page carries.
const NUMBER_OCR_INTERVAL_MS = 700
const NUMBER_CONFIDENCE_THRESHOLD = 80
const NUMBER_CONFIDENCE_MEDIUM_THRESHOLD = 50
const REQUIRED_HIGH_CONFIDENCE_PASSES = 3
const NUMBER_BAND_FALLBACK_PASSES = 3
// How many recently-confirmed cards the on-screen stack keeps at once —
// see RecentScansStack below. Matches the "3 or 5" the feature was
// requested at. Set to 3, not 5: at the thumbnail's actual h-[120px] size
// (bumped 3x from an earlier h-10 for legibility, see RecentScanThumb),
// 5 stacked thumbnails (5*120 + 4*6 gap = 624px) is taller than the video
// container itself at this component's own default 3:4 aspect and max
// width (384/0.75 = 512px) — the oldest one or two would render clipped
// off above the video's top edge. 3 (372px) fits comfortably instead.
const RECENT_SCANS_LIMIT = 3
// How long the oldest thumbnail's collapse animation runs before it's
// actually dropped from state (see addRecentScan) — must match the
// duration in RecentScansStack's own transition classes below.
const RECENT_SCAN_COLLAPSE_MS = 300

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

function normalizeNumberForPreview(value) {
  return String(value || '').trim().replace(/^0+(?=\d)/, '').toUpperCase()
}

// Phase 3, Decision 8: a plain client-side lookup against this deck
// instance's own still-missing cards, no network call. A reasoned
// approximation of the backend's real normalize_scanner_card_number
// (strips leading zeros, case-insensitive) — this is only a preview; the
// actual save decision still goes through the backend's authoritative
// match.
function findUniqueMissingCardName(missingCards, numberLocal) {
  if (!numberLocal || !missingCards?.length) return null
  const target = normalizeNumberForPreview(numberLocal)
  const matches = missingCards.filter((c) => normalizeNumberForPreview(c.number) === target)
  return matches.length === 1 ? matches[0].name : null
}

// Background only — the reading itself is always black text (see the badge
// JSX below), so this just tints the pill by confidence tier. Near-opaque
// (/90), not a light translucent tint: this badge sits directly over the
// live camera feed, not a fixed app surface, and a translucent tint over a
// dark/dim scene (indoor lighting, a shadowed tabletop — exactly when a
// user is squinting at this reading) composites toward black, at which
// point black text has no contrast left at all. Matches this same file's
// own precedent for text over unpredictable video content — the
// processing overlay (bg-black/60) and warning toast (bg-black/85) both
// go near-opaque for the same reason.
function confidenceBadgeClass(confidence) {
  if (confidence >= NUMBER_CONFIDENCE_THRESHOLD) return 'bg-green/90'
  if (confidence >= NUMBER_CONFIDENCE_MEDIUM_THRESHOLD) return 'bg-yellow/90'
  // NOT the .badge-red/bg-brand-red class — --color-brand-red is
  // theme-swapped (yellow in "electric", green in "grass", etc., see
  // index.css and currentBrandRed() above), which would collide with
  // drawOverlay's unrelated use of that same variable in at least two
  // themes. pokemon-red (tailwind.config.js) is a fixed, non-theme-swapped
  // literal (#e3000b) — the actually-fixed token this needs.
  return 'bg-pokemon-red/90'
}

// Maps every _identity_decision value the backend can send to one small,
// shared set of translation keys. Two different routes compute this today
// — match_deck_image (backend/api/decks.py, the free deck-scoped tier) and
// recognize_card (backend/api/recognize.py, the paid fallback) — with two
// different raw vocabularies for the same underlying ideas ("deck_phash"
// vs "phash" both mean an image match), so this is one shared mapping
// rather than per-route logic. Returns null for anything without a real
// decision — an ambiguous match a human picked from the candidate list
// never has one; only an auto-resolved save does.
function decisionLabelKey(decision) {
  switch (decision) {
    case 'deck_phash':
    case 'phash':
      return 'decks.scan.pathImageMatch'
    case 'deck_number_unique':
    case 'number_unique':
      return 'decks.scan.pathOcrNumber'
    case 'deck_name_unique':
      return 'decks.scan.pathOcrName'
    case 'number_metadata':
    case 'artist_hp':
      return 'decks.scan.pathMetadata'
    default:
      // Covers "gemini_visual" and every other provider's own
      // "{provider}_visual" (see recognize.py) without needing to name
      // each provider here.
      return decision?.endsWith('_visual') ? 'decks.scan.pathVisionApi' : null
  }
}

// One thumbnail in the recent-scans stack. Mounts at opacity-0/translated
// down, then flips to its resting state a frame later — a plain mount
// effect, not a library, so the newest card visibly slides/fades in at the
// bottom of the stack rather than just popping into place. Also doubles as
// a quick-add button (Decision: reuse the exact same confirmCard save path
// every other confirm uses, rather than a separate lightweight call — see
// onQuickAdd below) — tapping it saves another copy of that same card
// without needing to physically re-present it to the camera, for
// duplicates (energy cards especially) where scanning each physical copy
// individually is pure friction.
function RecentScanThumb({ scan, collapsing, onQuickAdd, quickAddDisabled, confirming, label, pathLabel }) {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className="grid transition-[grid-template-rows] ease-out"
      style={{
        gridTemplateRows: collapsing ? '0fr' : '1fr',
        transitionDuration: `${RECENT_SCAN_COLLAPSE_MS}ms`,
      }}
    >
      <div className="overflow-hidden">
        <button
          type="button"
          onClick={() => onQuickAdd(scan)}
          disabled={quickAddDisabled}
          aria-label={label}
          className="pointer-events-auto relative block transition-all duration-300 ease-out disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          style={{
            // Combines the mount/collapse animation's own opacity with the
            // disabled dimming every other control in this app uses
            // (disabled:opacity-50, see .btn-primary/.btn-ghost in
            // index.css) — a Tailwind class alone can't win here since
            // this same opacity is already driven inline for the
            // animation, and inline styles always beat a class.
            opacity: entered && !collapsing ? (quickAddDisabled ? 0.5 : 1) : 0,
            transform: entered && !collapsing ? 'translateY(0)' : 'translateY(8px)',
          }}
        >
          <img
            src={scan.image}
            alt={scan.name}
            // 3x the original h-10 (40px) — real-device feedback was that
            // the card needed to actually be readable at a glance, not
            // just present as a tiny icon.
            className="h-[120px] w-auto rounded-lg border border-white/25 object-contain shadow-lg"
          />
          {confirming ? (
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
              <Loader2 size={20} className="animate-spin text-white" />
            </span>
          ) : (
            <>
              {/* A plain image doesn't read as tappable on its own — this
                  marks it as "tap for another" without needing a label
                  visible at all times. */}
              <span className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-white/40 bg-brand-red text-white shadow">
                <Plus size={14} strokeWidth={3} />
              </span>
              {/* Which recognition path resolved this save (item 5,
                  docs/plans/scanner-ux-todos.md) — a trust/diagnostic
                  signal, not something every scan needs read out loud, so
                  it's a quiet corner badge rather than part of the main
                  capture flow. Opposite corner from the quick-add "+" so
                  neither crowds the other. */}
              {pathLabel && (
                <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold text-white">
                  {pathLabel}
                </span>
              )}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

// Vertical stack of the last RECENT_SCANS_LIMIT confirmed cards, newest at
// the bottom (see addRecentScan, which appends). Anchored to the video's
// bottom-right corner (not top) so the effect is a real "push up": the
// newest thumbnail always lands in the same fixed bottom slot, and each
// earlier one is shifted upward to make room above it purely by normal
// flex-column layout — no per-item transform math needed. Floats over the
// video feed rather than sitting in normal flow — same reasoning as the
// "Scan now" button below: a portrait video can fill most of the
// viewport, so anything meant to stay visible during hunting has to
// overlay it, not follow it.
function RecentScansStack({ scans, collapsingKeys, label, onQuickAdd, quickAddDisabled, confirmingKey, quickAddLabel, t }) {
  if (!scans.length) return null
  return (
    <div
      className="absolute right-2 bottom-2 z-10 flex flex-col gap-1.5"
      aria-label={label}
    >
      {scans.map((scan) => {
        const pathLabelKey = decisionLabelKey(scan.decision)
        return (
          <RecentScanThumb
            key={scan.key}
            scan={scan}
            collapsing={collapsingKeys.has(scan.key)}
            onQuickAdd={onQuickAdd}
            quickAddDisabled={quickAddDisabled}
            confirming={confirmingKey === scan.key}
            label={`${quickAddLabel}: ${scan.name}`}
            pathLabel={pathLabelKey ? t(pathLabelKey) : null}
          />
        )
      })}
    </div>
  )
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
 *
 * missingCards (optional, docs/plans/live-card-scanner.md Phase 3): this
 * deck instance's still-missing {number, name} pairs, already fetched by
 * DeckDetail.jsx — used only for Path B's client-side name-preview lookup
 * (Decision 8), never sent anywhere.
 */
export default function DeckCardScanner({ isOpen, onClose, onConfirm, deckInstanceId, missingCards = [] }) {
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
  // { name, quantity } for a warning (checkmarkStatus !== 'counted') — the
  // captured card's name and, only for 'already_complete', the deck's
  // expected quantity for it (see backend services/deck_progress.py's
  // register_scan), so the warning can say e.g. "4/4 Pikachu already
  // scanned" instead of a generic message with no specifics.
  const [checkmarkMeta, setCheckmarkMeta] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  // Last RECENT_SCANS_LIMIT confirmed cards (any save through confirmCard,
  // auto or manual), newest last — see RecentScansStack. collapsingScanKeys
  // names every entry currently mid collapse-out animation — a Set, not a
  // single key: quick-add (see quickAddRecentScan) can be tapped faster
  // than RECENT_SCAN_COLLAPSE_MS apart, so more than one overflow entry can
  // be collapsing at once. recentScanRemovalTimersRef tracks one timeout
  // per pending key (a single shared ref/timeout here previously meant a
  // later rapid tap's clearTimeout cancelled an earlier tap's pending
  // removal, permanently — the stack would grow past RECENT_SCANS_LIMIT
  // and never re-settle under a burst of quick-adds).
  const [recentScans, setRecentScans] = useState([])
  const [collapsingScanKeys, setCollapsingScanKeys] = useState(() => new Set())
  const recentScanRemovalTimersRef = useRef(new Map())
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

  // Phase 3's Path B (docs/plans/live-card-scanner.md) — a throttled,
  // number-only OCR pass independent of the tick loop above. Strictly
  // serial (Decision 6): numberOcrInFlightRef guards this loop the same
  // way tickInFlightRef guards the 90ms one, but is kept separate — a
  // several-hundred-ms Tesseract call inside the 90ms tick would stall
  // quad detection entirely, defeating the point of throttling OCR apart
  // from it. highConfidenceStreakRef counts consecutive passes at/above
  // NUMBER_CONFIDENCE_THRESHOLD (Decision 7); passesSinceValidReadRef
  // counts consecutive passes with no regex-valid number read at all, so
  // numberBand.js can widen its guess (see the throttled effect below).
  const numberOcrInFlightRef = useRef(false)
  const highConfidenceStreakRef = useRef(0)
  const passesSinceValidReadRef = useRef(0)
  const numberCropCanvasRef = useRef(null)
  const [liveNumberConfidence, setLiveNumberConfidence] = useState(null)
  const [liveNumberText, setLiveNumberText] = useState(null)
  const [liveNamePreview, setLiveNamePreview] = useState(null)

  const resetNumberOcrState = () => {
    highConfidenceStreakRef.current = 0
    passesSinceValidReadRef.current = 0
    setLiveNumberConfidence(null)
    setLiveNumberText(null)
    setLiveNamePreview(null)
  }

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
    resetNumberOcrState()
    setPhase('hunting')
    // recentScans is deliberately NOT reset here — real-device feedback
    // was that closing the scanner and coming straight back (e.g. to check
    // something else in the app) shouldn't wipe the scan history the user
    // was just looking at. It only ever grows via addRecentScan and trims
    // itself at RECENT_SCANS_LIMIT, so there's nothing stale to clear.
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
    recentScanRemovalTimersRef.current.forEach(clearTimeout)
    recentScanRemovalTimersRef.current.clear()
  }, [])

  // deckScanStatus (see backend services/deck_progress.py's SCAN_* constants,
  // round-tripped through onConfirm's response below) picks which overlay
  // shows: the usual green checkmark for "counted", or a yellow warning for
  // a card that didn't move deck progress at all — not in this deck's
  // template, or already at its expected quantity. Silently treating those
  // the same as a real match (the previous behavior) meant a mis-scan or a
  // duplicate looked identical to a correctly-tracked card.
  const enterSuccessCooldown = (deckScanStatus = 'counted', meta = null) => {
    setResult(null)
    setError(null)
    setPhase('success')
    setCheckmarkStatus(deckScanStatus)
    setCheckmarkMeta(meta)
    setShowCheckmark(true)
    awaitingCardRemovalRef.current = pendingCaptureQuadRef.current
    const holdDuration = deckScanStatus === 'counted' ? CHECKMARK_DURATION_MS : WARNING_DURATION_MS
    timersRef.current.push(setTimeout(() => setShowCheckmark(false), holdDuration))
    timersRef.current.push(setTimeout(() => {
      stabilityTrackerRef.current.reset()
      resetNumberOcrState()
      setPhase('hunting')
    }, holdDuration + COOLDOWN_AFTER_CHECKMARK_MS))
  }

  const resetForNextCard = () => {
    clearTimers()
    setResult(null)
    setError(null)
    setConfirmError(null)
    setConfirmingKey(null)
    stabilityTrackerRef.current.reset()
    resetNumberOcrState()
    setPhase(cameraFallbackLockedRef.current ? 'cameraDenied' : 'hunting')
  }

  // Ends a warning overlay early on tap — clears its own pending timers
  // (the ones enterSuccessCooldown scheduled) instead of waiting out
  // WARNING_DURATION_MS, so a user who's already read it isn't stuck
  // waiting. Not offered on the green checkmark — that's already quick
  // enough not to need a manual dismiss.
  const dismissWarning = () => {
    clearTimers()
    setShowCheckmark(false)
    stabilityTrackerRef.current.reset()
    resetNumberOcrState()
    setPhase(cameraFallbackLockedRef.current ? 'cameraDenied' : 'hunting')
  }

  const handleClose = () => {
    clearTimers()
    onClose?.()
  }

  // Appends a just-confirmed card to the recent-scans stack, trimming the
  // oldest entry once it grows past RECENT_SCANS_LIMIT. The trim doesn't
  // remove that entry immediately — it's flagged via collapsingScanKeys so
  // RecentScanThumb can animate it away first, and only actually dropped
  // from recentScans once that entry's own timeout fires. Keyed by
  // id+timestamp (not just candidate.id) so scanning the same card twice
  // in a row — an energy card, say — still gets two distinct stack
  // entries instead of React treating the second as an update to the
  // first.
  //
  // Each overflow entry gets its OWN timeout, tracked by key in
  // recentScanRemovalTimersRef, not one shared ref — quick-add lets a user
  // tap faster than RECENT_SCAN_COLLAPSE_MS apart (the exact "several
  // duplicate energy cards" case it exists for), and a single shared timer
  // would have its pending removal cancelled by every subsequent tap's
  // clearTimeout, so only the last tap in a burst ever actually fired,
  // permanently growing the stack past its cap.
  const addRecentScan = (candidate, decision = null) => {
    const entry = {
      key: `${candidate.id || 'card'}-${Date.now()}-${Math.random()}`,
      image: resolveCardImageUrl(candidate, 'small'),
      name: candidate.name,
      // Kept so a stack entry can be quick-added again later (see
      // quickAddRecentScan) without re-deriving it from image/name alone.
      candidate,
      // Which tier resolved this save (see decisionLabelKey) — null for a
      // manual pick from the ambiguous list or a quick-add re-save with no
      // decision of its own to inherit.
      decision,
    }
    setRecentScans((current) => {
      const next = [...current, entry]
      const overflowCount = Math.max(0, next.length - RECENT_SCANS_LIMIT)
      const newlyCollapsing = []
      for (let i = 0; i < overflowCount; i++) {
        const oldestKey = next[i].key
        // Already has a timer running from an earlier call — don't
        // reschedule it (that's exactly the bug this replaces).
        if (recentScanRemovalTimersRef.current.has(oldestKey)) continue
        newlyCollapsing.push(oldestKey)
        const timeoutId = setTimeout(() => {
          setRecentScans((scans) => scans.filter((scan) => scan.key !== oldestKey))
          setCollapsingScanKeys((keys) => {
            const nextKeys = new Set(keys)
            nextKeys.delete(oldestKey)
            return nextKeys
          })
          recentScanRemovalTimersRef.current.delete(oldestKey)
        }, RECENT_SCAN_COLLAPSE_MS)
        recentScanRemovalTimersRef.current.set(oldestKey, timeoutId)
      }
      if (newlyCollapsing.length > 0) {
        setCollapsingScanKeys((keys) => new Set([...keys, ...newlyCollapsing]))
      }
      return next
    })
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
  // undo can be correlated back to the scan trace it's reversing. decision
  // is the raw _identity_decision string (see decisionLabelKey) from
  // whichever tier auto-resolved this save, stored on the resulting
  // recent-scans entry — null for a manual ambiguous-list pick or a
  // quick-add re-save with no decision of its own.
  const confirmCard = async (candidate, key, isAutoSave = false, traceId = null, decision = null) => {
    setConfirmingKey(key)
    setConfirmError(null)
    try {
      const response = await onConfirm(candidate, { isAutoSave, traceId })
      addRecentScan(candidate, decision)
      // The fallback path skips the checkmark theater — just clear back to
      // the ready-to-scan-next state (resetForNextCard already routes to
      // 'cameraDenied' vs 'hunting' correctly based on the same lock).
      if (cameraFallbackLockedRef.current) {
        resetForNextCard()
      } else {
        enterSuccessCooldown(response?.data?.deck_scan_status, {
          name: candidate.name,
          quantity: response?.data?.deck_scan_quantity,
        })
      }
      return true
    } catch {
      setConfirmError(t('decks.scan.confirmFailed'))
      return false
    } finally {
      setConfirmingKey(null)
    }
  }

  // Quick-add: tapping a recent-scans thumbnail saves another copy of that
  // same card without re-presenting it to the camera — the energy-card
  // duplicate use case. Deliberately routes through the exact same
  // confirmCard() path a real capture uses (not a lighter-weight direct
  // onConfirm call) so it gets the same checkmark/warning feedback and the
  // same already-wired error toast (see DeckDetail.jsx's scanMutation
  // onError) for free, instead of a second, easier-to-drift-out-of-sync
  // save path. Only while actively hunting — tapping mid-capture would
  // race enterSuccessCooldown's own phase/timer changes against this one's.
  const quickAddRecentScan = (scan) => {
    if (phase !== 'hunting' || confirmingKey != null || !scan.candidate) return
    // Propagates the original scan's own decision forward — this is the
    // same card, identified the same way, not a fresh recognition event.
    confirmCard(scan.candidate, scan.key, false, null, scan.decision)
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
        const saved = await confirmCard(topCandidate, topCandidate.id || 'auto', true, data.trace_id, data._identity_decision)
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

  // Phase 3's Path B (docs/plans/live-card-scanner.md) — fires once the
  // throttled number-only loop below sustains high confidence for
  // REQUIRED_HIGH_CONFIDENCE_PASSES. Unlike captureAndRecognize, this never
  // falls through to the paid recognizeCard API or the 'ambiguous' picker:
  // Path B only ever has a number (and, from missingCards, at most a
  // preview name), never a full-card photo worth showing a picker for — a
  // non-confident or failed-save result just resumes scanning. skip_phash
  // (the 6th matchDeckImage arg) is required here per the plan's "pHash
  // false-positive risk" Risk: cropCanvas is a number-only fragment, not a
  // full card, and pHash on a fragment could land closer to the wrong
  // candidate than to none at all.
  const attemptZoomMatch = async (cropCanvas, ocrFields) => {
    setPhase('processing')
    setProcessingSeconds(0)
    processingTimerRef.current = setInterval(() => setProcessingSeconds((s) => s + 1), 1000)
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob || !deckInstanceId) {
        resetForNextCard()
        return
      }
      const data = await matchDeckImage(
        deckInstanceId, blob,
        { numberLocal: ocrFields.number_local, name: null },
        'live_zoom_scan', controller.signal, true,
      )
      const topCandidate = data?.matches?.[0]
      if (data?._identity_confident && topCandidate) {
        const saved = await confirmCard(topCandidate, topCandidate.id || 'auto', true, data.trace_id, data._identity_decision)
        if (!saved) resetForNextCard()
      } else {
        resetForNextCard()
      }
    } catch (err) {
      if (controller.signal.aborted) {
        resetForNextCard()
        return
      }
      setDebugInfo((d) => ({ ...d, tickError: `zoom-match: ${describeError(err)}` }))
      resetForNextCard()
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

  // ---- Phase 3's Path B: throttled, number-only OCR loop ----
  // Independent of the 90ms detection loop above — runs whether or not a
  // quad is currently detected, so zooming in past the card's edges (where
  // detectCardQuad returns null and the loop above never captures) still
  // gets a live reading. Gated on the same phase/cameraStatus condition, so
  // this pauses automatically the instant either loop's own
  // captureAndRecognize/attemptZoomMatch sets phase to 'processing'.
  useEffect(() => {
    if (phase !== 'hunting' || cameraStatus !== 'streaming') return undefined

    const intervalId = setInterval(async () => {
      if (numberOcrInFlightRef.current) return
      const video = videoRef.current
      const cropCanvas = numberCropCanvasRef.current
      if (!video || !cropCanvas || video.readyState < 2 || !video.videoWidth) return

      numberOcrInFlightRef.current = true
      try {
        const quadInfo = latestQuadRef.current
        const fallbackLevel = Math.min(2, Math.floor(passesSinceValidReadRef.current / NUMBER_BAND_FALLBACK_PASSES))
        const sourceCanvas = quadInfo ? detectionCanvasRef.current : video
        const sourceWidth = quadInfo ? quadInfo.detectionWidth : video.videoWidth
        const sourceHeight = quadInfo ? quadInfo.detectionHeight : video.videoHeight
        if (!sourceCanvas) return

        const rect = computeNumberBandRect(sourceWidth, sourceHeight, quadInfo?.quad, fallbackLevel)
        const cropWidth = Math.max(1, Math.round(rect.width))
        const cropHeight = Math.max(1, Math.round(rect.height))
        cropCanvas.width = cropWidth
        cropCanvas.height = cropHeight
        cropCanvas.getContext('2d').drawImage(
          sourceCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, cropWidth, cropHeight,
        )

        const { number_local, number_total, confidence } = await recognizeNumberRegion(cropCanvas)
        const numberText = number_local && number_total ? `${number_local}/${number_total}` : null
        passesSinceValidReadRef.current = numberText ? 0 : passesSinceValidReadRef.current + 1

        setLiveNumberConfidence(confidence)
        setLiveNumberText(numberText)
        setLiveNamePreview(numberText ? findUniqueMissingCardName(missingCards, number_local) : null)

        // Gates *when* to attempt the deck-scoped match (Decision 7) — not
        // proof the match is correct. The uniqueness check inside
        // attemptZoomMatch's matchDeckImage call is what actually protects
        // against a confidently-read misread colliding with a different
        // missing card.
        const meetsThreshold = Boolean(numberText) && confidence >= NUMBER_CONFIDENCE_THRESHOLD
        highConfidenceStreakRef.current = meetsThreshold ? highConfidenceStreakRef.current + 1 : 0

        if (highConfidenceStreakRef.current >= REQUIRED_HIGH_CONFIDENCE_PASSES) {
          highConfidenceStreakRef.current = 0
          await attemptZoomMatch(cropCanvas, { number_local })
        }
      } catch (err) {
        setDebugInfo((d) => ({ ...d, tickError: `number-ocr: ${describeError(err)}` }))
      } finally {
        numberOcrInFlightRef.current = false
      }
    }, NUMBER_OCR_INTERVAL_MS)

    return () => clearInterval(intervalId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cameraStatus])

  // The detection outline is only ever (re)drawn by the hunting-phase tick
  // loop above, which stops running the instant a capture fires (phase
  // leaves 'hunting') — so without this, the last frame's outline just sits
  // there, frozen, for the entire processing/checkmark/warning sequence
  // that follows, and only clears once hunting resumes and redraws it.
  // Real-device feedback: the box should disappear as soon as the card
  // stops being actively detected, not linger until the result banner
  // itself goes away.
  useEffect(() => {
    if (phase === 'hunting') return
    const canvas = overlayCanvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }, [phase])

  // Freeze the visible frame instead of letting it keep playing behind the
  // spinner/candidate list/checkmark — matches the plan's "freeze + crop"
  // flow rather than a live feed still moving under a result the user is
  // looking at. A warning overlay is the one exception: it floats over the
  // feed rather than covering it (see the warning branch below), so the
  // feed underneath should stay live — a real-device report was that the
  // warning only ever appeared over a frozen/blacked-out frame, which read
  // as broken.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const keepLive = phase === 'hunting' || (phase === 'success' && checkmarkStatus !== 'counted')
    if (keepLive) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [phase, videoRef, checkmarkStatus])

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

  // e.g. "4/4 Pikachu already scanned" — checkmarkMeta.quantity (the deck's
  // expected_quantity, see register_scan) is only ever set alongside
  // 'already_complete'; scanned_quantity always equals it in that state, so
  // one number covers both sides of the fraction. 'not_in_deck' has no
  // quantity to show (the card isn't in the deck's template at all), so it
  // stays name + a plain explanation.
  const warningText = checkmarkStatus === 'already_complete'
    ? `${checkmarkMeta?.quantity ?? '?'}/${checkmarkMeta?.quantity ?? '?'} ${checkmarkMeta?.name ?? ''} ${t('decks.scan.alreadyCompleteDetail')}`.trim()
    : `${checkmarkMeta?.name ?? ''} ${t('decks.scan.notInDeckDetail')}`.trim()

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
              <canvas ref={numberCropCanvasRef} className="hidden" aria-hidden="true" />

              <RecentScansStack
                scans={recentScans}
                collapsingKeys={collapsingScanKeys}
                label={t('decks.scan.recentScans')}
                onQuickAdd={quickAddRecentScan}
                quickAddDisabled={phase !== 'hunting' || confirmingKey != null}
                confirmingKey={confirmingKey}
                quickAddLabel={t('decks.scan.quickAdd')}
                t={t}
              />

              {/* Phase 3's Path B live readout — its own pill, not the hint
                  slot below, so it doesn't compete with the single-line
                  hint's own text (see the dynamic hint below). Placed
                  opposite the "Scan now" button (bottom-3) and clear of
                  RecentScansStack (right-2 bottom-2). */}
              {phase === 'hunting' && liveNumberConfidence != null && (
                <div
                  className={`absolute top-3 left-3 rounded-lg px-2.5 py-1.5 font-mono font-semibold text-black shadow-lg ${confidenceBadgeClass(liveNumberConfidence)}`}
                  aria-label={`${t('decks.scan.numberReadLabel')}: ${liveNumberConfidence}%`}
                >
                  <div className="text-lg leading-tight">{liveNumberConfidence}%{liveNumberText ? ` — ${liveNumberText}` : ''}</div>
                  {liveNamePreview && (
                    <div className="mt-0.5 text-xs font-normal opacity-80">{liveNamePreview}</div>
                  )}
                </div>
              )}

              {/* Floats over the bottom of the video frame rather than
                  sitting below it in normal flow — on a phone, a
                  portrait-aspect video can fill most of the viewport,
                  pushing anything placed after it below the fold until the
                  user scrolls. This stays reachable the instant hunting
                  starts, no scrolling required. */}
              {phase === 'hunting' && (
                <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
                  <button
                    type="button"
                    onClick={handleScanNow}
                    className="btn-primary pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                  >
                    {t('decks.scan.scanNow')}
                  </button>
                </div>
              )}

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

              {phase === 'success' && showCheckmark && checkmarkStatus === 'counted' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <span
                    className="inline-flex items-center justify-center rounded-full border border-green/40 bg-green/90 p-4 text-white shadow-lg"
                    aria-label={t('decks.scan.captured')}
                  >
                    <Check size={32} strokeWidth={3} aria-hidden />
                  </span>
                </div>
              )}

              {phase === 'success' && showCheckmark && checkmarkStatus !== 'counted' && (
                // Floats over the still-live video (see the video-play
                // effect above) instead of covering it with a dark scrim —
                // a real-device report was that this only ever appeared
                // over a frozen/blacked-out frame. Tappable to dismiss
                // early: WARNING_DURATION_MS is generous specifically
                // because reading it shouldn't be rushed, so the user needs
                // a way to move on sooner once they have.
                <div className="absolute inset-x-0 top-4 flex justify-center px-4 pointer-events-none">
                  <button
                    type="button"
                    onClick={dismissWarning}
                    className="pointer-events-auto flex max-w-[92%] items-center gap-2 rounded-xl border border-yellow/50 bg-black/85 px-4 py-3 text-left shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/70"
                  >
                    <AlertTriangle size={22} className="flex-shrink-0 text-yellow" aria-hidden />
                    <span className="text-sm font-semibold text-yellow">{warningText}</span>
                  </button>
                </div>
              )}
            </div>

            {phase === 'hunting' && (
              <p className="text-xs text-text-muted text-center max-w-xs">
                {liveNumberConfidence != null && liveNumberConfidence < NUMBER_CONFIDENCE_THRESHOLD
                  ? t('decks.scan.liveHintLowConfidence')
                  : t('decks.scan.liveHint')}
              </p>
            )}

            {/* confirmError is set by confirmCard's own catch block — a
                quick-add tap (RecentScanThumb) hits this exact path while
                still in 'hunting', not just the ambiguous-picker's manual
                tap below. Without this, a failed quick-add previously had
                no visible feedback at all: the thumbnail's spinner just
                stopped, silently, with the copy never actually saved. */}
            {phase === 'hunting' && confirmError && (
              <p className="text-sm text-brand-red text-center max-w-xs">{confirmError}</p>
            )}

            {phase === 'error' && (
              <div className={`${ERROR_BANNER_CLASS} w-full max-w-sm`}>
                <p className="text-sm text-brand-red">{error}</p>
                <button onClick={resetForNextCard} className="btn-primary mt-3 mx-auto text-sm">
                  {t('decks.scan.tryAgain')}
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
              {debugInfo.tickError && <><br />tick error: {debugInfo.tickError}</>}
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
            </div>
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
                <button onClick={resetForNextCard} className="btn-primary mx-auto text-sm">{t('decks.scan.tryAgain')}</button>
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
                  onClick={() => confirmCard(candidate, key, false, result.trace_id, result._identity_decision)}
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
