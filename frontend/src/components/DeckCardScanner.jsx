import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Camera, Check, Info, Loader2, Minus, Plus, Settings, X } from 'lucide-react'
import { matchDeckImage, recognizeCard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import { useCameraStream } from '../hooks/useCameraStream'
import { detectCardQuad, extractCard, preloadCardDetection } from '../utils/cardDetection'
import { preloadCardOcr, preloadNumberOcr, recognizeCardText, recognizeNumberRegion } from '../utils/cardOcr'
import { createStabilityTracker, quadsAreStable } from '../utils/quadStability'
import { computeNumberBandRect } from '../utils/numberBand'
import { computeSharpnessVariance, sharpnessVarianceToPercent } from '../utils/imageSharpness'
import {
  OVERLAY_SMOOTHING_ALPHA_VALUES,
  getStoredSmoothingSpeedIndex,
  setStoredSmoothingSpeedIndex,
} from '../utils/outlineSmoothing'
import { CardModal } from './CardItem'

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
// A resolved job's capturedRegionsRef entry used to clear on the very next
// empty-frame tick — but a single glitchy tick (motion blur, a lighting
// flicker, a momentary autofocus hunt) can report an empty frame even
// though the physical card never actually left. When that lands right
// after a job resolves, the already-saved card reads as newly arrived
// once detection recovers, producing a genuine duplicate save. Requiring
// a short run of consecutive empty ticks — the removal-side mirror of
// REQUIRED_STABLE_FRAMES on the capture side — treats a single blip as
// noise instead of a real removal.
const EMPTY_FRAME_DEBOUNCE_TICKS = 3
// A warning (not in this deck / already have enough) needs real reading
// time, hence the generous duration — dismissible early with a tap (see
// dismissWarningById) so a user who's already read it isn't stuck waiting
// the full duration.
const WARNING_DURATION_MS = 4000
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
// Gates the auto-trigger streak below — never itself displayed any more
// (docs/plans/scanner-ux-todos.md item 7 replaced the live badge with an
// image-quality reading; this OCR-confidence threshold still exists
// purely to decide when a number read is trustworthy enough to attempt a
// deck match, same as before).
const NUMBER_CONFIDENCE_THRESHOLD = 80
const REQUIRED_HIGH_CONFIDENCE_PASSES = 3
const NUMBER_BAND_FALLBACK_PASSES = 3
// How many recently-confirmed cards the on-screen stack keeps at once —
// see RecentScansStack below. Matches the "3 or 5" the feature was
// requested at. Set to 4, not 5: at the thumbnail's actual h-[120px] size
// (bumped 3x from an earlier h-10 for legibility, see RecentScanThumb), 5
// stacked thumbnails (5*120 + 4*6 gap = 624px) is still taller than the
// video container itself at this component's own default 3:4 aspect and
// max width (384/0.75 = 512px) — the oldest would render clipped off
// above the video's top edge. 4 (498px) fits with margin to spare.
// Originally 3 (item 2, docs/plans/scanner-ux-todos.md) — raised to 4
// once removing the debug/OCR readout and low-confidence hint (item 6)
// freed enough of the screen that a fourth slot was worth the space.
const RECENT_SCANS_LIMIT = 4
// How long the oldest thumbnail's collapse animation runs before it's
// actually dropped from state (see addRecentScan) — must match the
// duration in RecentScansStack's own transition classes below.
const RECENT_SCAN_COLLAPSE_MS = 300
// Phase 1 of docs/plans/scanner-continuous-scan.md: how many cards can be
// mid-recognition at once. Needs real-device tuning like every other
// threshold on this page — too high risks firing several paid-API calls
// back-to-back if cards are presented faster than they resolve; too low
// barely improves on one-at-a-time throughput.
const MAX_CONCURRENT_JOBS = 2

const ERROR_BANNER_CLASS = 'card border-brand-red/30 bg-brand-red/5 text-center py-4'

function scaleQuad(quad, scaleX, scaleY) {
  const scalePoint = ({ x, y }) => ({ x: x * scaleX, y: y * scaleY })
  return {
    topLeftCorner: scalePoint(quad.topLeftCorner),
    topRightCorner: scalePoint(quad.topRightCorner),
    bottomLeftCorner: scalePoint(quad.bottomLeftCorner),
    bottomRightCorner: scalePoint(quad.bottomRightCorner),
  }
}

// How much each drawn frame moves toward the latest raw detection, not all
// the way (docs/plans/scanner-ux-todos.md item 9) — a reasoned starting
// point, not empirically calibrated against real devices yet, same caveat
// every other tuning constant on this page carries. Higher tracks the raw
// quad more closely (less smoothing, more jitter); lower lags further
// behind a genuine reposition before catching up. History: 0.35 (initial)
// lagged noticeably behind the actual card → raised to 0.5, which then
// read as too jumpy again → settled here, between the two. Now
// user-adjustable (docs/plans/scanner-pause-speed-details.md) via the
// scanner's own settings popup — see OVERLAY_SMOOTHING_ALPHA_VALUES in
// utils/outlineSmoothing.js, index DEFAULT_SMOOTHING_SPEED_INDEX (0.42)
// preserving this exact history as the shipped default.

function lerpQuad(prev, next, alpha) {
  const lerpPoint = (p, n) => ({ x: p.x + (n.x - p.x) * alpha, y: p.y + (n.y - p.y) * alpha })
  return {
    topLeftCorner: lerpPoint(prev.topLeftCorner, next.topLeftCorner),
    topRightCorner: lerpPoint(prev.topRightCorner, next.topRightCorner),
    bottomLeftCorner: lerpPoint(prev.bottomLeftCorner, next.bottomLeftCorner),
    bottomRightCorner: lerpPoint(prev.bottomRightCorner, next.bottomRightCorner),
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

// Reasoned starting points for the image-quality badge below, not
// empirically calibrated against real devices/cameras yet — same caveat
// every other tuning constant on this page carries (docs/plans/
// scanner-ux-todos.md item 7).
const IMAGE_QUALITY_GOOD_THRESHOLD = 60
const IMAGE_QUALITY_MEDIUM_THRESHOLD = 30

// Background only — the reading itself is always black text (see the badge
// JSX below), so this just tints the pill by quality tier. Near-opaque
// (/90), not a light translucent tint: this badge sits directly over the
// live camera feed, not a fixed app surface, and a translucent tint over a
// dark/dim scene (indoor lighting, a shadowed tabletop — exactly when a
// user is squinting at this reading) composites toward black, at which
// point black text has no contrast left at all. Matches this same file's
// own precedent for text over unpredictable video content — the
// processing overlay (bg-black/60) and warning toast (bg-black/85) both
// go near-opaque for the same reason.
function imageQualityBadgeClass(quality) {
  if (quality >= IMAGE_QUALITY_GOOD_THRESHOLD) return 'bg-green/90'
  if (quality >= IMAGE_QUALITY_MEDIUM_THRESHOLD) return 'bg-yellow/90'
  // NOT the .badge-red/bg-brand-red class — --color-brand-red is
  // theme-swapped (yellow in "electric", green in "grass", etc., see
  // index.css and currentBrandRed() above), which would collide with
  // drawOverlay's unrelated use of that same variable in at least two
  // themes. pokemon-red (tailwind.config.js) is a fixed, non-theme-swapped
  // literal (#e3000b) — the actually-fixed token this needs.
  return 'bg-pokemon-red/90'
}

// Maps every _identity_decision value the backend can send to one small,
// shared set of translation keys. Two different routes compute these
// values today — match_deck_image (backend/api/decks.py, the free
// deck-scoped tier) and recognize_card (backend/api/recognize.py, the paid
// fallback) — with two different raw vocabularies for the same underlying
// ideas ("deck_phash" vs "phash" both mean an image match), so this is one
// shared mapping rather than per-route logic. Returns null for anything
// without a real decision — an ambiguous match a human picked from the
// candidate list never has one. A quick-add re-save has no decision of its
// own either (see confirmCard's quickAddTarget) — it bumps an existing
// thumbnail's count rather than labeling a new one, so the badge shown
// stays whatever the original real scan resolved to.
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

// e.g. "4/4 Pikachu already scanned" — warning.quantity (the deck's
// expected_quantity, see register_scan) is only ever set alongside
// 'already_complete'; scanned_quantity always equals it in that state, so
// one number covers both sides of the fraction. 'not_in_deck' has no
// quantity to show (the card isn't in the deck's template at all), so it
// stays name + a plain explanation.
function warningLabel(warning, t) {
  return warning.status === 'already_complete'
    ? `${warning.quantity ?? '?'}/${warning.quantity ?? '?'} ${warning.name ?? ''} ${t('decks.scan.alreadyCompleteDetail')}`.trim()
    : `${warning.name ?? ''} ${t('decks.scan.notInDeckDetail')}`.trim()
}

// One thumbnail in the recent-scans stack. Mounts at opacity-0/translated
// down, then flips to its resting state a frame later — a plain mount
// effect, not a library, so the newest card visibly slides/fades in at the
// bottom of the stack rather than just popping into place. The "+"/"-"
// live in a side stepper beside the image instead of a badge overlapping
// it (a corner bubble was easy to miss as a real tap target and left no
// room for a matching "-" to remove an over-tapped add) — quick-add/
// remove are the stepper's job, not the image's, so there's exactly one
// control per action instead of two differently-labelled ways to do the
// same thing. The stepper also carries the running count once quantity >
// 1, instead of a new thumbnail per "+" tap (see quickAddRecentScan/
// bumpRecentScanQuantity) — a card image only ever appears here because
// it was actually scanned. The image itself IS a tap target again as of
// item 8 (docs/plans/scanner-pause-speed-details.md) — but for a
// DIFFERENT action (view details/the real captured photo) than the one
// it was deliberately stripped of above, so it doesn't reintroduce the
// "two ways to do the same thing" problem; see the small Info corner
// badge below for why this one gets an explicit visual affordance the
// stepper's own buttons don't need.
function RecentScanThumb({ scan, collapsing, onQuickAdd, onDecrement, onViewDetails, quickAddDisabled, confirming, label, removeLabel, viewDetailsLabel, pathLabel }) {
  const [entered, setEntered] = useState(false)
  // collapsing (mid exit-animation, either RECENT_SCANS_LIMIT overflow or
  // decrementRecentScan hitting quantity 0) must also disable both
  // buttons — the row stays mounted and tappable for RECENT_SCAN_COLLAPSE_MS
  // after its own removal is already scheduled, so without this a fast tap
  // during that window could bump/undo a quantity moments before
  // scheduleRecentScanRemoval's timeout filters the entry out regardless,
  // silently dropping that add/undo from the visible stack.
  const addDisabled = quickAddDisabled || collapsing
  // Always enabled otherwise (docs/plans/scanner-ux-todos.md item 5) — a
  // confirmation dialog, not this disabled state, is what stands between
  // a tap and an actual removal now; see decrementRecentScan.
  const removeDisabled = quickAddDisabled || collapsing

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
      <div className={collapsing ? 'overflow-hidden' : ''}>
        <div
          className="pointer-events-auto flex items-center gap-1.5 transition-all duration-300 ease-out"
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
          <div className="relative block">
            {/* Tap for card details + the actual captured photo (item 8,
                docs/plans/scanner-pause-speed-details.md) — a plain <img>
                with no visual cue was already tried on this exact
                thumbnail for a DIFFERENT action (quick-add) and moved
                away from for being easy to miss as a real tap target (see
                this component's own doc comment above); the small Info
                badge below, reusing the same corner-badge visual language
                as the pathLabel badge, is deliberate so this new tap
                target doesn't repeat that. */}
            <button
              type="button"
              onClick={() => onViewDetails(scan)}
              disabled={collapsing}
              aria-label={viewDetailsLabel}
              className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed"
            >
              <img
                src={scan.image}
                alt={scan.name}
                // 3x the original h-10 (40px) — real-device feedback was that
                // the card needed to actually be readable at a glance, not
                // just present as a tiny icon.
                className="h-[120px] w-auto rounded-lg border border-white/25 object-contain shadow-lg"
              />
            </button>
            {confirming && (
              <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
                <Loader2 size={20} className="animate-spin text-brand-red" />
              </span>
            )}
            {!confirming && (
              <span className="absolute top-1 left-1 rounded-full bg-black/75 p-1 pointer-events-none">
                <Info size={11} className="text-white/90" />
              </span>
            )}
            {/* Which recognition path resolved this save (item 4,
                docs/plans/scanner-ux-todos.md) — a trust/diagnostic
                signal, not something every scan needs read out loud, so
                it's a quiet corner badge rather than part of the main
                capture flow. left-1/right-1 (not a fixed width) plus
                truncate bounds it to the thumbnail's own width and
                ellipsizes rather than overflowing — "Metadata match" at
                this font size is close to the full thumbnail width on
                its own. */}
            {!confirming && pathLabel && (
              <span className="absolute bottom-1 left-1 right-1 truncate rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold text-white">
                {pathLabel}
              </span>
            )}
          </div>
          {/* Side stepper: +/- beside the image rather than on top of it,
              with the running quantity between them once there's more
              than one copy — a plain number, not a new thumbnail, per
              the image-only-appears-on-an-actual-scan rule above. Sized to
              its own content (not stretched to the image's 120px height,
              which left large dead gaps between the buttons) and centered
              alongside it via the row's items-center above. Buttons match
              this file's existing 36px circular tap target (see the w-9
              h-9 close button) rather than a smaller one-off, now that the
              image itself is no longer also a tap target. */}
          <div className="flex flex-col items-center gap-1 rounded-full border border-white/15 bg-black/70 px-1 py-1.5">
            <button
              type="button"
              onClick={() => onQuickAdd(scan)}
              disabled={addDisabled}
              aria-label={label}
              className="grid h-9 w-9 place-items-center rounded-full bg-brand-red text-white shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={18} strokeWidth={3} />
            </button>
            {scan.quantity > 1 && (
              <span className="px-0.5 text-sm font-extrabold tabular-nums text-white">{scan.quantity}</span>
            )}
            <button
              type="button"
              onClick={() => onDecrement(scan)}
              disabled={removeDisabled}
              aria-label={removeLabel}
              // Dims only the icon when disabled, not the button's own
              // bg-white/15 fill — that fill is already translucent
              // against the busy camera feed behind it, and compounding
              // disabled:opacity-50 on top made it disappear entirely
              // instead of reading as a disabled (but present) control.
              className="grid h-9 w-9 place-items-center rounded-full bg-white/15 shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed"
            >
              <Minus size={18} strokeWidth={3} className={removeDisabled ? 'text-white/40' : 'text-white'} />
            </button>
          </div>
        </div>
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
//
// confirmingKeys is a Set, not a single value — Phase 1 of docs/plans/
// scanner-continuous-scan.md lets several confirms genuinely overlap (two
// concurrent auto-saves, or a quick-add tap landing while a different
// card's auto-save is still in flight), so only the thumbnail actually
// mid-save should show its own spinner and disable itself; the others
// stay tappable.
function RecentScansStack({ scans, collapsingKeys, label, onQuickAdd, onDecrement, onViewDetails, quickAddDisabled, confirmingKeys, quickAddLabel, removeLabel, viewDetailsLabel, t }) {
  if (!scans.length) return null
  return (
    <div
      className="absolute right-2 bottom-2 z-10 flex flex-col gap-1.5"
      aria-label={label}
    >
      {scans.map((scan) => {
        const isConfirming = confirmingKeys.has(scan.key)
        const pathLabelKey = decisionLabelKey(scan.decision)
        return (
          <RecentScanThumb
            key={scan.key}
            scan={scan}
            collapsing={collapsingKeys.has(scan.key)}
            onQuickAdd={onQuickAdd}
            onDecrement={onDecrement}
            onViewDetails={onViewDetails}
            quickAddDisabled={quickAddDisabled || isConfirming}
            confirming={isConfirming}
            label={`${quickAddLabel}: ${scan.name}`}
            removeLabel={`${removeLabel}: ${scan.name}`}
            viewDetailsLabel={`${viewDetailsLabel}: ${scan.name}`}
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
 * Phase 1 of docs/plans/scanner-continuous-scan.md: a confident capture no
 * longer blocks the camera. Detection keeps running and further cards can
 * be captured (up to MAX_CONCURRENT_JOBS at once, beyond that queued —
 * see submitCapture) while earlier ones are still being recognized in the
 * background — see startJob/finishJob. `phase` now only ever represents a
 * genuinely full-screen state (hunting, ambiguous, error, cameraDenied, or
 * the camera-denied fallback's own single-shot 'processing'); a confident
 * background job's progress/result never touches it. Ambiguous matches and
 * hard failures are explicitly NOT covered by this — they still take over
 * the whole screen exactly as before (see the plan's scope decision); a
 * background job that resolves into either while other jobs are still in
 * flight is a known, accepted edge case for this phase, not handled
 * specially.
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
export default function DeckCardScanner({ isOpen, onClose, onConfirm, onDecrement, deckInstanceId, missingCards = [] }) {
  const { t } = useSettings()
  const confirmDialog = useConfirmDialog()

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
  // { quad, jobId } for detection-frame regions of cards already captured
  // (and possibly still being recognized in the background) that shouldn't
  // be captured again while they're still sitting in frame — an array, not
  // a single value, since Phase 1 lets more than one card be in flight at
  // once. Pushed to immediately at capture time, paired with that same
  // capture's job id (see submitCapture), not after a save completes: the
  // point is to stop a still-unmoved card from being re-captured WHILE its
  // first capture is still being recognized (or still queued), not just
  // after. An empty frame drops any entry whose job has ALREADY resolved
  // (this camera can only look at one screen position per tick anyway, so
  // a stale resolved entry for a position it isn't currently pointed at
  // only matters if that position comes back into frame later, which the
  // next empty-frame clear will already have caught by then) — but keeps
  // entries whose job is still pending, specifically so a card that's
  // briefly removed and immediately re-presented at the same spot while
  // its own capture is still resolving isn't submitted as a second,
  // genuinely concurrent job for the identical physical card (see the tick
  // loop's own empty-frame handling and submitCapture's isJobPending use).
  const capturedRegionsRef = useRef([])
  // Consecutive empty-detection ticks in a row — see EMPTY_FRAME_DEBOUNCE_
  // TICKS's own comment for why a resolved job's region needs a short run
  // of these, not just one, before it's treated as genuinely removed.
  const emptyFrameStreakRef = useRef(0)
  // Most recent quad the tick loop actually saw, refreshed every tick and
  // cleared the moment a tick finds nothing — read by handleScanNow so the
  // manual "Scan now" button can fire off the same quad the overlay is
  // currently drawing, without waiting for REQUIRED_STABLE_FRAMES of hold
  // time.
  const latestQuadRef = useRef(null)
  // The last DRAWN outline, smoothed toward each new raw quad rather than
  // snapping straight to it (docs/plans/scanner-ux-todos.md item 9) — real
  // hand jitter moves a held card's detected corners a few pixels every
  // tick even while it reads as "stable," which looked like the outline
  // itself was unsteady. Only ever read/written by drawOverlay's own call
  // in the tick loop below; every other consumer of a quad (the stability
  // tracker, capture, capturedRegionsRef matching) keeps reading the RAW
  // per-tick quad unchanged, so smoothing the drawn line can't shift when
  // a card actually gets captured.
  const smoothedQuadRef = useRef(null)

  // hunting | processing | ambiguous | error | cameraDenied — 'processing'
  // is reachable ONLY through the camera-denied fallback's single-shot
  // handleManualFile now (see the type's own doc comment above); a
  // confident live capture never sets phase at all any more.
  const [phase, setPhase] = useState('hunting')
  // Mirrors `phase` for the two async job-completion sites below
  // (captureAndRecognize's ambiguous/error branches) — those read the
  // LATEST phase to decide whether to render their own result at all, and
  // a plain closure over the `phase` variable would see whatever it was
  // when that specific async call started, not "right now" (see
  // MAX_CONCURRENT_JOBS: two captures can resolve seconds apart, well
  // after phase has moved on).
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])
  const [videoAspect, setVideoAspect] = useState(3 / 4)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  // The failed capture's own crop, so the full-screen error can show which
  // of possibly several in-flight/queued cards it's actually talking about
  // — see captureAndRecognize's catch block. null when extractCard itself
  // failed (nothing was ever cropped to show).
  const [errorCardImage, setErrorCardImage] = useState(null)
  // Tapping the failed-capture thumbnail opens it enlarged — reset
  // alongside errorCardImage so a stale "open" doesn't carry over into the
  // next error.
  const [showErrorPreview, setShowErrorPreview] = useState(false)
  // Focused on open (see the effect below) so the lightbox's own close
  // button — not the scanner modal's header close button sitting inert
  // underneath it — is what a keyboard/screen-reader user lands on. The
  // two buttons share a similar look, and without an explicit focus move,
  // a Tab press could just as easily reach the header one and close the
  // whole scanner instead of the preview it's covering.
  const errorPreviewCloseRef = useRef(null)
  useEffect(() => {
    if (showErrorPreview) errorPreviewCloseRef.current?.focus()
  }, [showErrorPreview])
  // docs/plans/scanner-pause-speed-details.md item 10 — suppresses only
  // the auto-capture trigger (both Path A's stable-hold submit and Path
  // B's zoom-match auto-save below); detection and the overlay keep
  // running live so the user can still see positioning feedback while
  // lining a card up. Momentary, not a device preference — resets every
  // time the scanner reopens (see the isOpen effect) rather than
  // persisting, so nobody who never touches the toggle sees any change,
  // and nobody accidentally leaves their scanner silently paused across
  // an unrelated later session.
  const [scanningPaused, setScanningPaused] = useState(false)
  // Mirrors `scanningPaused` for the tick loops' own setInterval
  // closures, same reasoning as phaseRef above — reading this via a ref
  // (not the state directly) means toggling pause doesn't need to tear
  // down and recreate either interval.
  const scanningPausedRef = useRef(scanningPaused)
  useEffect(() => {
    scanningPausedRef.current = scanningPaused
  }, [scanningPaused])
  // Outline-tracking speed (docs/plans/scanner-pause-speed-details.md) —
  // a device preference, unlike scanningPaused above: lazy-initialized
  // from localStorage and NOT reset by the isOpen effect, so it survives
  // the scanner closing and reopening.
  const [smoothingSpeedIndex, setSmoothingSpeedIndex] = useState(() => getStoredSmoothingSpeedIndex())
  const smoothingSpeedIndexRef = useRef(smoothingSpeedIndex)
  useEffect(() => {
    smoothingSpeedIndexRef.current = smoothingSpeedIndex
  }, [smoothingSpeedIndex])
  const [showSettings, setShowSettings] = useState(false)
  // Which recent-scan entry's detail view (item 8) is open, if any —
  // reset on isOpen alongside the other transient overlay flags above,
  // same reasoning as showErrorPreview: a stale "open" shouldn't carry
  // over into a freshly reopened scanner.
  const [detailScan, setDetailScan] = useState(null)
  // Last RECENT_SCANS_LIMIT confirmed cards (any save through confirmCard,
  // auto or manual — never a quick-add re-save, see bumpRecentScanQuantity),
  // newest last — see RecentScansStack. collapsingScanKeys names every
  // entry currently mid collapse-out animation — a Set, not a single key:
  // quick-add (see quickAddRecentScan) can be tapped faster than
  // RECENT_SCAN_COLLAPSE_MS apart, so more than one overflow entry can be
  // collapsing at once. recentScanRemovalTimersRef tracks one timeout per
  // pending key (a single shared ref/timeout here previously meant a later
  // rapid tap's clearTimeout cancelled an earlier tap's pending removal,
  // permanently — the stack would grow past RECENT_SCANS_LIMIT and never
  // re-settle under a burst of quick-adds).
  const [recentScans, setRecentScans] = useState([])
  const [collapsingScanKeys, setCollapsingScanKeys] = useState(() => new Set())
  const recentScanRemovalTimersRef = useRef(new Map())
  const [confirmError, setConfirmError] = useState(null)
  // Every key (recent-scans entry key, or the ambiguous list's own
  // candidate key) with a confirmCard/decrementRecentScan call currently in
  // flight — a Set, not a single value, so concurrent auto-saves (or a
  // quick-add landing during one) don't block each other. See
  // RecentScansStack's own comment for the UI half of this.
  const [confirmingKeys, setConfirmingKeys] = useState(() => new Set())
  // Recognition (Gemini identify + visual-match, see recognize.py) can take
  // well over a minute under real API load with the backend's own retries —
  // measured 89s in practice. A static "Identifying card..." spinner is
  // indistinguishable from hung at that duration; a running clock isn't.
  // Only ever driven by the camera-denied fallback's own handleManualFile
  // now — a live capture's own background progress has no per-job timer or
  // cancel button in Phase 1 (see the "N scanning" chip in the render body
  // instead), so this and abortControllerRef/cancelProcessing below are
  // scoped entirely to that one fallback flow.
  const [processingSeconds, setProcessingSeconds] = useState(0)
  const processingTimerRef = useRef(null)
  const abortControllerRef = useRef(null)

  // Phase 1 of docs/plans/scanner-continuous-scan.md — how many live
  // captures (Path A or Path B) are currently being recognized in the
  // background. activeJobsRef mirrors the state array for code that reads
  // it synchronously inside the detection tick loop's closure (a plain
  // state read there could be stale — the tick loop's own effect doesn't
  // re-run on every job change, only on phase/cameraStatus changes, so its
  // closure would otherwise keep seeing whatever activeJobs was when the
  // interval was created). jobControllersRef holds one AbortController per
  // job, keyed by id, aborted only on unmount (see the cleanup effect) —
  // there's no per-job cancel button in Phase 1, so nothing else ever
  // triggers one.
  const [activeJobs, setActiveJobs] = useState([])
  const activeJobsRef = useRef([])
  const jobControllersRef = useRef(new Map())
  // Cards captured while MAX_CONCURRENT_JOBS was already full — held as
  // {canvas, quad} until a slot frees up (see drainQueue, called from
  // finishJob). canvas is always a fresh, owned <canvas> (see
  // submitCapture), never one of this component's own shared/reused refs.
  const pendingQueueRef = useRef([])
  const [queuedCount, setQueuedCount] = useState(0)
  // Non-blocking warning toasts (not-in-deck / already-complete), one per
  // job that resolved that way — a Map/array instead of a single value for
  // the same reason confirmingKeys and capturedRegionsRef are collections
  // now: more than one can be genuinely concurrent. warningTimersRef tracks
  // each entry's own auto-dismiss timeout, same per-key pattern
  // recentScanRemovalTimersRef already established.
  const [activeWarnings, setActiveWarnings] = useState([])
  const warningTimersRef = useRef(new Map())

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
  // Sharpness-based "is this a good picture of the card" reading (see the
  // throttled effect below) — distinct from the OCR confidence used
  // internally for the auto-trigger threshold just above, which is never
  // itself displayed (docs/plans/scanner-ux-todos.md item 7).
  const [liveImageQuality, setLiveImageQuality] = useState(null)
  const [liveNumberText, setLiveNumberText] = useState(null)
  const [liveNamePreview, setLiveNamePreview] = useState(null)

  const resetNumberOcrState = () => {
    highConfidenceStreakRef.current = 0
    passesSinceValidReadRef.current = 0
    setLiveImageQuality(null)
    setLiveNumberText(null)
    setLiveNamePreview(null)
  }

  const cameraActive = isOpen && phase !== 'cameraDenied'
  const { videoRef, status: cameraStatus } = useCameraStream({ active: cameraActive })

  // Re-attempt camera access (and drop any stale result from a previous
  // session) every time the scanner is freshly opened — a user who denied
  // access once, or changed their browser's permission since, gets another
  // chance rather than being stuck on the fallback for good.
  useEffect(() => {
    if (!isOpen) return
    cameraFallbackLockedRef.current = false
    capturedRegionsRef.current = []
    emptyFrameStreakRef.current = 0
    latestQuadRef.current = null
    smoothedQuadRef.current = null
    setResult(null)
    setError(null)
    setErrorCardImage(null)
    setShowErrorPreview(false)
    setConfirmError(null)
    setScanningPaused(false)
    setShowSettings(false)
    setDetailScan(null)
    stabilityTrackerRef.current.reset()
    resetNumberOcrState()
    setPhase('hunting')
    // recentScans, activeJobs, and activeWarnings are deliberately NOT
    // reset here — real-device feedback was that closing the scanner and
    // coming straight back (e.g. to check something else in the app)
    // shouldn't wipe the scan history the user was just looking at, and a
    // background job doesn't stop just because the modal closed (see
    // handleClose) — it should still land, and still be visible, when the
    // user reopens.
  }, [isOpen])

  // Preload OpenCV.js/jscanify as soon as the scanner opens, so the first
  // stable hold doesn't stall on a ~10MB download. Path B's number-only OCR
  // worker (see cardOcr.js's preloadNumberOcr) is bundled into this same
  // upfront load, unlike Path A's own OCR worker (preloadCardOcr, still
  // deferred until a card is actually captured) — Path B's first read
  // fires ~700ms into hunting, sooner than a stable hold would even
  // complete, so it can't wait for a capture the way Path A's can.
  useEffect(() => {
    if (isOpen) {
      preloadCardDetection()
      preloadNumberOcr()
    }
  }, [isOpen])

  useEffect(() => {
    if (cameraStatus === 'denied' || cameraStatus === 'unavailable') {
      cameraFallbackLockedRef.current = true
      setPhase('cameraDenied')
    }
  }, [cameraStatus])

  useEffect(() => () => {
    clearInterval(processingTimerRef.current)
    abortControllerRef.current?.abort()
    jobControllersRef.current.forEach((controller) => controller.abort())
    recentScanRemovalTimersRef.current.forEach(clearTimeout)
    recentScanRemovalTimersRef.current.clear()
    warningTimersRef.current.forEach(clearTimeout)
    warningTimersRef.current.clear()
  }, [])

  const resetForNextCard = () => {
    setResult(null)
    setError(null)
    setErrorCardImage(null)
    setShowErrorPreview(false)
    setConfirmError(null)
    stabilityTrackerRef.current.reset()
    resetNumberOcrState()
    setPhase(cameraFallbackLockedRef.current ? 'cameraDenied' : 'hunting')
  }

  // Shows a non-blocking warning toast (not-in-deck / already-complete) —
  // floats over the still-live video, auto-dismisses after
  // WARNING_DURATION_MS, or earlier on tap (dismissWarningById). Replaces
  // the old single enterSuccessCooldown-driven warning: several of these
  // can now be showing at once (see activeWarnings's own comment).
  const addWarning = (status, meta) => {
    const id = `${Date.now()}-${Math.random()}`
    setActiveWarnings((current) => [...current, { id, status, ...meta }])
    const timeoutId = setTimeout(() => dismissWarningById(id), WARNING_DURATION_MS)
    warningTimersRef.current.set(id, timeoutId)
  }

  const dismissWarningById = (id) => {
    clearTimeout(warningTimersRef.current.get(id))
    warningTimersRef.current.delete(id)
    setActiveWarnings((current) => current.filter((warning) => warning.id !== id))
  }

  const handleClose = () => {
    onClose?.()
  }

  // Flags one stack entry as collapsing (see RecentScanThumb's grid-row
  // animation) and only actually drops it from recentScans once that
  // animation's own timeout fires. Shared by addRecentScan's overflow trim
  // below and decrementRecentScan's remove-at-zero — both are "this entry
  // is leaving the stack," just triggered differently.
  //
  // Each entry gets its OWN timeout, tracked by key in
  // recentScanRemovalTimersRef, not one shared ref — quick-add lets a user
  // tap faster than RECENT_SCAN_COLLAPSE_MS apart (the exact "several
  // duplicate energy cards" case it exists for), and a single shared timer
  // would have its pending removal cancelled by every subsequent tap's
  // clearTimeout, so only the last tap in a burst ever actually fired,
  // permanently growing the stack past its cap.
  const scheduleRecentScanRemoval = (key) => {
    // Already has a timer running from an earlier call — don't reschedule
    // it (that's exactly the bug the per-key timer map replaces).
    if (recentScanRemovalTimersRef.current.has(key)) return
    setCollapsingScanKeys((keys) => new Set([...keys, key]))
    const timeoutId = setTimeout(() => {
      setRecentScans((scans) => scans.filter((scan) => scan.key !== key))
      setCollapsingScanKeys((keys) => {
        const nextKeys = new Set(keys)
        nextKeys.delete(key)
        return nextKeys
      })
      recentScanRemovalTimersRef.current.delete(key)
    }, RECENT_SCAN_COLLAPSE_MS)
    recentScanRemovalTimersRef.current.set(key, timeoutId)
  }

  // Appends a just-confirmed REAL scan (a fresh camera capture or manual
  // ambiguous-list pick — never a quick-add re-save, see
  // bumpRecentScanQuantity) to the recent-scans stack, trimming the oldest
  // entry once it grows past RECENT_SCANS_LIMIT. Keyed by id+timestamp (not
  // just candidate.id) so scanning the same physical card twice in a row —
  // an energy card, say — still gets two distinct stack entries instead of
  // React treating the second as an update to the first; only the "+"
  // button folds repeats into one thumbnail's count.
  const addRecentScan = (candidate, decision, resolvedCardId, deckScanStatus, traceId, capturedImage = null) => {
    const entry = {
      key: `${candidate.id || 'card'}-${Date.now()}-${Math.random()}`,
      image: resolveCardImageUrl(candidate, 'small'),
      name: candidate.name,
      // Kept so a stack entry can be quick-added again later (see
      // quickAddRecentScan) without re-deriving it from image/name alone.
      candidate,
      // The actual photo the camera captured for THIS save (item 8,
      // docs/plans/scanner-pause-speed-details.md) — distinct from `image`
      // above (catalog artwork, always present). Only ever set for a
      // confidently-resolved live capture (Path A's captureAndRecognize
      // has a real cropCanvas in scope there); a manual ambiguous-list
      // pick or Path B's zoom-match auto-save have no full-card crop left
      // by confirm time, so this stays null and the detail view falls
      // back to catalog art instead. Lives and dies with this entry —
      // no separate storage/cleanup path, so it's already correctly
      // discarded whenever recentScans filters the entry out.
      capturedImage,
      // Which tier resolved this save (see decisionLabelKey) — null for a
      // manual pick from the ambiguous list. Never overwritten by a later
      // quick-add bump, since that badge describes how THIS card was
      // originally identified, not how every counted copy was added.
      decision,
      quantity: 1,
      // add_to_collection's own resolved id for this card (can differ from
      // candidate.id, see DeckDetail.jsx's scanMutation) — what
      // decrementRecentScan must pass to the undo route to target the
      // right CollectionItem row. Updated on every later bump too, since
      // "-" always reverses the MOST RECENT add, not the first.
      resolvedCardId,
      // Diagnostics correlation for that same most-recent add (only set
      // when scan diagnostics are enabled) — round-tripped to undo_scan
      // the same way the success toast's own Undo link does.
      traceId,
      // The MOST RECENT add's deck_scan_status — decrementRecentScan reads
      // this to pick which backend route can safely reverse it: 'counted'
      // goes through undo_scan (collection + deck progress together);
      // 'not_in_deck'/'already_complete' go through the collection-only
      // route instead, since undo_scan can't safely reverse those (see its
      // own docstring and docs/plans/scanner-ux-todos.md item 5) — either
      // is still always removable, just via a different route.
      deckScanStatus,
    }
    setRecentScans((current) => {
      const next = [...current, entry]
      const overflowCount = Math.max(0, next.length - RECENT_SCANS_LIMIT)
      for (let i = 0; i < overflowCount; i++) {
        scheduleRecentScanRemoval(next[i].key)
      }
      return next
    })
  }

  // Folds a quick-add re-save into the SAME thumbnail's count instead of
  // pushing a new one (see confirmCard's quickAddTarget param) — a card
  // image only ever appears here because it was actually scanned; tapping
  // "+" again just raises the digit beside it.
  const bumpRecentScanQuantity = (key, resolvedCardId, deckScanStatus, traceId) => {
    setRecentScans((current) => current.map((scan) => (
      scan.key === key ? { ...scan, quantity: scan.quantity + 1, resolvedCardId, deckScanStatus, traceId } : scan
    )))
  }

  // Shared by every confirm path — auto-save on a confident live detection,
  // a manual tap in the ambiguous candidate list, a tap from the
  // camera-denied fallback's own candidate list, and a quick-add re-save.
  // Awaits the caller's confirm action (adding the card to the deck)
  // before moving on; a failure stays visible via confirmError rather than
  // silently resetting. Returns whether the save succeeded, so callers
  // with no picker of their own (the auto-save path) know whether to fall
  // back to showing one. isAutoSave is threaded through to onConfirm so
  // DeckDetail.jsx's own success handler can show an Undo-capable toast
  // for auto-saves instead of stacking it on top of the existing plain one
  // (see DeckDetail.jsx). traceId (from recognizeCard()'s response, only
  // present when the user has scan diagnostics enabled) rides along the
  // same way, so an eventual undo can be correlated back to the scan trace
  // it's reversing. decision is the raw _identity_decision string (see
  // decisionLabelKey) from whichever tier auto-resolved this save, stored
  // on the resulting recent-scans entry — null for a manual ambiguous-list
  // pick. quickAddTarget is the existing stack entry a "+" tap is adding
  // another copy of — when set, the save bumps that entry's quantity
  // instead of pushing a new thumbnail (see bumpRecentScanQuantity).
  //
  // Deliberately never blocks the screen on success any more (Phase 1 of
  // docs/plans/scanner-continuous-scan.md) — a counted save's only
  // confirmation is the recent-scans thumbnail itself (already visible the
  // instant addRecentScan/bumpRecentScanQuantity runs); a warning gets a
  // non-blocking toast via addWarning instead of freezing hunting. Callers
  // that DO need to leave a full-screen state on success (the ambiguous
  // list, the camera-denied fallback) handle that themselves — see their
  // own call sites — rather than this function inferring it from ambient
  // phase, which could otherwise act on a stale value once concurrent jobs
  // are possible.
  const confirmCard = async (candidate, key, isAutoSave = false, traceId = null, decision = null, quickAddTarget = null, capturedImage = null) => {
    setConfirmingKeys((current) => new Set(current).add(key))
    setConfirmError(null)
    // Whether THIS call will show its own not-in-deck/already-complete
    // warning below (every path except the camera-denied fallback, which
    // has no live video to float one over) — passed through onConfirm so
    // DeckDetail.jsx's scanMutation can skip its OWN warning toast for the
    // same event instead of showing it twice. Read once, up front: the
    // fallback lock can't change mid-call, and this must describe what
    // THIS specific save is about to do either way.
    const hasLiveWarningOverlay = !cameraFallbackLockedRef.current
    try {
      const response = await onConfirm(candidate, { isAutoSave, traceId, hasLiveWarningOverlay })
      const resolvedCardId = response?.data?.card_id ?? candidate.id
      // See addRecentScan's deckScanStatus comment — decrementRecentScan
      // reads this back to pick the right undo route.
      const deckScanStatus = response?.data?.deck_scan_status
      if (quickAddTarget) {
        // capturedImage deliberately not forwarded here — it describes how
        // THIS entry was originally identified (see addRecentScan's own
        // comment), not the fact that a duplicate copy was just quick-added
        // with no new photo of its own.
        bumpRecentScanQuantity(quickAddTarget.key, resolvedCardId, deckScanStatus, traceId)
      } else {
        addRecentScan(candidate, decision, resolvedCardId, deckScanStatus, traceId, capturedImage)
      }
      if (!hasLiveWarningOverlay) {
        // The fallback flow has no live video to float a warning toast
        // over — just clear back to its own ready-to-scan-next state.
        resetForNextCard()
      } else if (deckScanStatus && deckScanStatus !== 'counted') {
        addWarning(deckScanStatus, { name: candidate.name, quantity: response?.data?.deck_scan_quantity })
      }
      return true
    } catch {
      setConfirmError(t('decks.scan.confirmFailed'))
      return false
    } finally {
      setConfirmingKeys((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  // Quick-add: tapping the "+" beside a recent-scans thumbnail saves
  // another copy of that same card without re-presenting it to the
  // camera — the energy-card duplicate use case. Deliberately routes
  // through the exact same confirmCard() path a real capture uses (not a
  // lighter-weight direct onConfirm call) so it gets the same
  // checkmark/warning feedback and the same already-wired error toast (see
  // DeckDetail.jsx's scanMutation onError) for free, instead of a second,
  // easier-to-drift-out-of-sync save path — it just passes itself as
  // confirmCard's quickAddTarget so the save bumps this thumbnail's count
  // rather than creating a new one. Gated per-key (confirmingKeys.has),
  // not globally — a different card auto-saving in the background, or a
  // different thumbnail's own quick-add, shouldn't block this one.
  const quickAddRecentScan = (scan) => {
    if (phase !== 'hunting' || confirmingKeys.has(scan.key) || !scan.candidate) return
    confirmCard(scan.candidate, scan.key, false, null, null, scan)
  }

  // The "-" beside a recent-scans thumbnail: reverses the single most
  // recent add to this entry. Always allowed regardless of that add's
  // deck_scan_status (docs/plans/scanner-ux-todos.md item 5) — onDecrement
  // picks the route that can safely reverse it: undo_scan (collection +
  // deck progress together) for 'counted', the collection-only route for
  // 'not_in_deck'/'already_complete', which undo_scan itself can't reverse
  // (see its own docstring). A destructive, one-way action with no
  // undo-of-the-undo, so it's confirmed first — same confirm-before-act
  // pattern this app already uses for deck reset/delete. At quantity 1,
  // confirming removes the whole thumbnail (the image only exists because
  // that one add happened); above 1, it just lowers the count.
  const decrementRecentScan = async (scan) => {
    if (phase !== 'hunting' || confirmingKeys.has(scan.key)) return
    const confirmed = await confirmDialog({
      message: t('decks.scan.removeCardConfirm'),
      confirmLabel: t('common.remove'),
      destructive: true,
    })
    if (!confirmed) return
    setConfirmingKeys((current) => new Set(current).add(scan.key))
    setConfirmError(null)
    try {
      await onDecrement(scan.resolvedCardId, scan.traceId, scan.deckScanStatus)
      if (scan.quantity <= 1) {
        scheduleRecentScanRemoval(scan.key)
      } else {
        setRecentScans((current) => current.map((s) => (
          s.key === scan.key ? { ...s, quantity: s.quantity - 1 } : s
        )))
      }
    } catch {
      setConfirmError(t('decks.scan.removeFailed'))
    } finally {
      setConfirmingKeys((current) => {
        const next = new Set(current)
        next.delete(scan.key)
        return next
      })
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
      try {
        ocrFields = await runOcr(nativeFrameSource, quad, CARD_CROP_WIDTH, CARD_CROP_HEIGHT)
      } catch (err2) {
        if (signal.aborted) throw err2
      }
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
      return null
    }
  }

  // Registers a new background job (Phase 1) — added to activeJobs (and
  // its ref mirror, for the tick loop's own synchronous reads) the instant
  // a capture is actually sent for recognition. Returns the job's id.
  // Accepts a pre-generated id (see submitCapture, which needs the same id
  // to already exist before a job might even start — see its own
  // capturedRegionsRef comment) — Path B's attemptZoomMatch has no such id
  // of its own and just lets this generate one.
  const startJob = (id = `${Date.now()}-${Math.random()}`) => {
    // activeJobsRef is updated directly, synchronously, here — not inside
    // the setActiveJobs updater below. React doesn't guarantee a
    // functional setState's updater runs synchronously at call time (it
    // can defer to the next render pass), and drainQueue (called from
    // finishJob, right after the equivalent update there) needs the
    // CURRENT count immediately, not whenever React next re-renders.
    // setActiveJobs itself only needs to schedule the re-render for the
    // "N scanning" count in the UI.
    activeJobsRef.current = [...activeJobsRef.current, id]
    setActiveJobs(activeJobsRef.current)
    return id
  }

  // Removes a job once it's fully resolved (saved, ambiguous, or errored —
  // see captureAndRecognize/attemptZoomMatch's own finally blocks) and
  // immediately tries to drain the queue, so a card that was waiting for a
  // slot starts the moment one frees up.
  const finishJob = (id) => {
    jobControllersRef.current.delete(id)
    // Same reasoning as startJob: update the ref directly and
    // synchronously before calling drainQueue, not inside setActiveJobs's
    // updater — drainQueue's own MAX_CONCURRENT_JOBS check needs this
    // job's removal to be visible immediately, not whenever React next
    // re-renders. (Verified the hard way: with the ref updated inside the
    // updater instead, a queued card never dequeued — drainQueue read a
    // stale, still-full activeJobsRef and bailed out every time.)
    activeJobsRef.current = activeJobsRef.current.filter((jobId) => jobId !== id)
    setActiveJobs(activeJobsRef.current)
    drainQueue()
  }

  const drainQueue = () => {
    if (activeJobsRef.current.length >= MAX_CONCURRENT_JOBS) return
    const queued = pendingQueueRef.current.shift()
    setQueuedCount(pendingQueueRef.current.length)
    if (!queued) return
    captureAndRecognize(queued.canvas, queued.quad, queued.jobId)
  }

  // Whether a job (active or still queued) hasn't resolved yet — used by
  // the tick loop's empty-frame handler below to decide which
  // capturedRegionsRef entries an empty frame is allowed to drop.
  const isJobPending = (jobId) => (
    activeJobsRef.current.includes(jobId) || pendingQueueRef.current.some((q) => q.jobId === jobId)
  )

  // Starts recognizing a freshly-captured card, or queues it if
  // MAX_CONCURRENT_JOBS slots are already full (Phase 1 of docs/plans/
  // scanner-continuous-scan.md). sourceCanvas is always copied into a
  // fresh, owned canvas here before doing anything async: sourceCanvas is
  // one of this component's own shared, reused canvases (captureCanvasRef),
  // which the very next 90ms tick is free to overwrite the instant this
  // function returns, now that a capture no longer blocks the detection
  // loop while it's recognized — captureAndRecognize's own extractCard
  // call reads from it more than once (the upload crop, then again for
  // OCR), so it has to still hold the right pixels for its entire,
  // possibly-queued lifetime, not just this instant. detectionQuad
  // (detection-frame coordinates) is what capturedRegionsRef tracks; quad
  // (native/full-resolution) is what actually gets sent for cropping.
  //
  // The job's id is generated HERE, before it's even known whether this
  // capture starts immediately or sits queued — capturedRegionsRef needs
  // it right away (paired with detectionQuad) so the tick loop's
  // empty-frame handler can tell "this position's job is still pending"
  // apart from "this position's job already resolved," and only clear the
  // latter. Without that distinction: a card captured, then physically
  // removed and immediately re-presented at the same spot WHILE its first
  // capture is still being recognized (or still queued behind
  // MAX_CONCURRENT_JOBS) — a brief, realistic hand-wobble/re-check, not an
  // edge case — cleared the position's only tracked region on that single
  // empty tick, and got captured a second time as a genuinely concurrent
  // job for the exact same physical card, i.e. a real duplicate scan.
  const submitCapture = (sourceCanvas, quad, detectionQuad) => {
    const jobId = `${Date.now()}-${Math.random()}`
    if (detectionQuad) capturedRegionsRef.current.push({ quad: detectionQuad, jobId })
    const snapshot = document.createElement('canvas')
    snapshot.width = sourceCanvas.width
    snapshot.height = sourceCanvas.height
    snapshot.getContext('2d').drawImage(sourceCanvas, 0, 0)
    if (activeJobsRef.current.length >= MAX_CONCURRENT_JOBS) {
      pendingQueueRef.current.push({ canvas: snapshot, quad, jobId })
      setQueuedCount(pendingQueueRef.current.length)
      return
    }
    captureAndRecognize(snapshot, quad, jobId)
  }

  const captureAndRecognize = async (snapshotCanvas, quad, jobId) => {
    startJob(jobId)
    const controller = new AbortController()
    jobControllersRef.current.set(jobId, controller)
    // Deliberately not preloaded upfront alongside OpenCV.js (see
    // cardOcr.js / frontend/public/tesseract/VENDORED.md) — only starts
    // downloading once a card is actually being captured, so it doesn't
    // double the initial scanner-open payload for a feature that only
    // pays off after detection already succeeded.
    preloadCardOcr()
    // Hoisted so the catch block below can show it on the error screen —
    // still null there if extractCard itself is what failed.
    let cropCanvas = null
    try {
      cropCanvas = await extractCard(snapshotCanvas, CARD_CROP_WIDTH, CARD_CROP_HEIGHT, quad)
      if (!cropCanvas) throw new Error('extract-failed')
      const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob) throw new Error('capture-failed')

      let data = await tryOcrMatch(snapshotCanvas, quad, blob, controller.signal)
      if (!data?._identity_confident) {
        data = await recognizeCard(blob, 'live_auto_scan', controller.signal)
      }
      const topCandidate = data?.matches?.[0]

      // phaseRef guard (both branches below, and the catch block): with
      // MAX_CONCURRENT_JOBS concurrent captures, a DIFFERENT job's own
      // ambiguous/error outcome can already be on screen awaiting the user
      // (pick a candidate / tap Try Again) by the time this one resolves.
      // Without this check, that outcome silently replaced whatever the
      // user was already looking at before they could act on it — this
      // job's own (also-unconfident/failed) outcome is dropped instead,
      // same "one interactive result visible at a time" rule already
      // covered for successes by errorOthersStillScanning below.
      if (data?._identity_confident && topCandidate) {
        // capturedImage (item 8, docs/plans/scanner-pause-speed-details.md):
        // the only confirmCard call site with a real full-card cropCanvas
        // still in scope — quickAddTarget's own slot (6th param) is passed
        // explicitly as null to reach this trailing one.
        const saved = await confirmCard(
          topCandidate, topCandidate.id || 'auto', true, data.trace_id, data._identity_decision,
          null, cropCanvas.toDataURL('image/jpeg', 0.7),
        )
        if (!saved && phaseRef.current !== 'error' && phaseRef.current !== 'ambiguous') {
          setResult(data)
          setPhase('ambiguous')
        }
      } else if (phaseRef.current !== 'error' && phaseRef.current !== 'ambiguous') {
        // Zero candidates at all (not just "not confident enough to
        // auto-save") routes through the same error UI as a thrown
        // exception below, rather than the ambiguous picker's own
        // separate "no match found" text on a bare background — from the
        // user's side there's nothing to actually pick between either
        // way, and real-device feedback was that the two different-looking
        // dead ends for what's functionally the same outcome ("this scan
        // didn't work, try again") were confusing. The picker still shows
        // normally whenever there's at least one real candidate.
        if (data?.matches?.length > 0) {
          setResult(data)
          setPhase('ambiguous')
        } else {
          setError(t('decks.scan.failed'))
          setErrorCardImage(cropCanvas ? cropCanvas.toDataURL('image/jpeg', 0.7) : null)
          setPhase('error')
        }
      }
    } catch (err) {
      // Only ever unmount-driven now (see the cleanup effect) — there's no
      // per-job cancel button in Phase 1 — so there's nothing to reset on
      // abort; the component is going away regardless.
      if (controller.signal.aborted) return
      if (phaseRef.current !== 'error' && phaseRef.current !== 'ambiguous') {
        setError(t('decks.scan.failed'))
        setErrorCardImage(cropCanvas ? cropCanvas.toDataURL('image/jpeg', 0.7) : null)
        setPhase('error')
      }
    } finally {
      finishJob(jobId)
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
    const jobId = startJob()
    const controller = new AbortController()
    jobControllersRef.current.set(jobId, controller)
    try {
      const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob || !deckInstanceId) return
      const data = await matchDeckImage(
        deckInstanceId, blob,
        { numberLocal: ocrFields.number_local, name: null },
        'live_zoom_scan', controller.signal, true,
      )
      const topCandidate = data?.matches?.[0]
      if (data?._identity_confident && topCandidate) {
        await confirmCard(topCandidate, topCandidate.id || 'auto', true, data.trace_id, data._identity_decision)
      }
      // Not confident: nothing to do — Path A/B are already continuously
      // scanning, there's no "resume" step left now that neither ever
      // stopped for this attempt.
    } catch {
      // Fire-and-forget (see this function's own doc comment) — a failed
      // zoom-match attempt just resumes scanning silently, same as a
      // not-confident one.
    } finally {
      finishJob(jobId)
    }
  }

  // Aborts whichever processing-phase request is currently in flight for
  // the camera-denied fallback's own handleManualFile — see
  // abortControllerRef's own comment for why this is a real
  // AbortController, not just a "please ignore the eventual result" flag.
  const cancelProcessing = () => {
    abortControllerRef.current?.abort()
  }

  // Manual override for when the auto-capture is taking too long to kick in
  // (quad detected but not holding steady long enough, or REQUIRED_STABLE_
  // FRAMES just feels slow to an impatient user who can see the card is
  // sitting right there). Fires the same submitCapture path the tick
  // loop's own readyToCapture branch uses, seeded with whatever quad the
  // tick loop most recently saw (latestQuadRef) rather than waiting for a
  // fresh stable streak. If no quad has been seen at all (e.g. detection is
  // struggling with lighting/angle), falls back to the full video frame —
  // still worth sending; recognizeCard doesn't require a perfectly
  // perspective-corrected crop, just a photo of the card.
  const handleScanNow = () => {
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
      submitCapture(captureCanvas, nativeQuad, seen?.quad || null)
    } finally {
      tickInFlightRef.current = false
    }
  }

  // ---- live detection loop: only runs while actively hunting ----
  // Phase 1: this no longer stops just because a capture is being
  // recognized — only the genuinely full-screen states (ambiguous, error,
  // cameraDenied) pause it, since phase never leaves 'hunting' for a
  // confident background job any more. submitCapture is fire-and-forget
  // here (not awaited) specifically so this loop's own tickInFlightRef
  // guard releases immediately after handing a capture off, instead of
  // staying locked for the whole recognize/confirm round-trip the way it
  // used to — that lock, not just the old phase gate, was the other half
  // of why detection used to fully stop during a capture.
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
          // An empty frame usually means whatever was previously captured
          // has been physically removed (or panned away from) — but NOT
          // when that region's own job (active or still queued) hasn't
          // resolved yet: a card can be briefly removed and immediately
          // re-presented at the same spot while its first capture is still
          // being recognized, and a full clear here would let that reads
          // as a "new" card, submitting a genuinely concurrent second job
          // for the identical physical card (see submitCapture's own
          // comment). Entries whose job HAS already resolved still get
          // dropped, but only once EMPTY_FRAME_DEBOUNCE_TICKS empty frames
          // have landed in a row — see that constant's own comment for why
          // a single one isn't enough to trust.
          emptyFrameStreakRef.current += 1
          if (emptyFrameStreakRef.current >= EMPTY_FRAME_DEBOUNCE_TICKS) {
            capturedRegionsRef.current = capturedRegionsRef.current.filter((region) => isJobPending(region.jobId))
          }
        } else {
          emptyFrameStreakRef.current = 0
        }
        const { consecutiveStableFrames, readyToCapture } = stabilityTrackerRef.current.observe(
          quad, detectionWidth, detectionHeight,
        )

        // Smoothed toward the raw quad rather than snapped to it (see
        // smoothedQuadRef's own comment) — resets instantly on an empty
        // frame (nothing to lag toward) rather than smoothing out to
        // nothing, which would leave a stale outline lingering after a
        // card is actually removed.
        smoothedQuadRef.current = quad
          ? (smoothedQuadRef.current
            ? lerpQuad(smoothedQuadRef.current, quad, OVERLAY_SMOOTHING_ALPHA_VALUES[smoothingSpeedIndexRef.current])
            : quad)
          : null

        const overlayScaleX = overlayCanvas.width / detectionWidth
        const overlayScaleY = overlayCanvas.height / detectionHeight
        drawOverlay(
          overlayCanvas,
          smoothedQuadRef.current && scaleQuad(smoothedQuadRef.current, overlayScaleX, overlayScaleY),
          consecutiveStableFrames / REQUIRED_STABLE_FRAMES,
        )

        // Matched against the region's quad, then immediately updated to
        // follow it (below) rather than left frozen at the position it was
        // captured at — a held card drifts a little every tick even while
        // reading as "stable" (real hand jitter, not movement), and once
        // detection runs continuously through a job's whole lifetime
        // (Phase 1) that drift accumulates against a fixed anchor until it
        // exceeds STABILITY_TOLERANCE_PROPORTION, reading the same physical
        // card as a new one and firing a duplicate capture. Following the
        // drift, the same way the stability tracker's own lastQuad already
        // does, keeps the comparison against the last-seen position instead
        // of a stale one.
        const matchedRegion = quad && capturedRegionsRef.current.find((region) => (
          quadsAreStable(region.quad, quad, detectionWidth, detectionHeight, STABILITY_TOLERANCE_PROPORTION)
        ))
        if (matchedRegion) matchedRegion.quad = quad
        const isAwaitingRemoval = Boolean(matchedRegion)

        // !scanningPausedRef.current: docs/plans/scanner-pause-speed-details.md
        // item 10 — pausing suppresses only this auto-trigger, not
        // detection/the overlay above, so positioning feedback stays live
        // while lining a card up. handleScanNow's own manual submitCapture
        // call — a separate button handler, not part of this tick loop —
        // is deliberately NOT gated the same way; it's the intended way to
        // fire a capture on demand while paused.
        if (readyToCapture && quad && !isAwaitingRemoval && !scanningPausedRef.current) {
          const captureCanvas = captureCanvasRef.current
          captureCanvas.width = video.videoWidth
          captureCanvas.height = video.videoHeight
          captureCanvas.getContext('2d').drawImage(video, 0, 0)
          const nativeQuad = scaleQuad(quad, video.videoWidth / detectionWidth, video.videoHeight / detectionHeight)
          submitCapture(captureCanvas, nativeQuad, quad)
        }
      } catch {
        // A rejected detection tick just retries on the next one — nothing
        // to surface (see docs/plans/scanner-ux-todos.md item 6).
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
  // gets a live reading. Gated on the same phase/cameraStatus condition,
  // which (Phase 1) no longer changes for a confident background job — see
  // the detection loop's own comment above for why. attemptZoomMatch is
  // fire-and-forget here for the same reason submitCapture is: so this
  // loop's own numberOcrInFlightRef releases immediately and the live
  // confidence badge keeps updating every ~700ms instead of freezing for
  // however long one zoom-match attempt's network round-trip takes.
  // cropCanvas is snapshotted into its own owned canvas before handing it
  // off, same reasoning as submitCapture's — cropCanvas itself
  // (numberCropCanvasRef) is a shared, reused canvas the very next tick
  // is free to overwrite, and unlike extractCard's likely-synchronous
  // pixel read, canvas.toBlob() is genuinely, unavoidably asynchronous.
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

        // Image-quality badge (docs/plans/scanner-ux-todos.md item 7) —
        // independent of the OCR read below (a blurry photo can still OCR
        // a number fine, and a sharp one can OCR poorly if the number's
        // small or worn, so this can't be derived from OCR confidence).
        // No quad, no reading: a quality score for the whole video frame
        // (background included) wouldn't mean "is THIS card in focus."
        if (quadInfo) {
          const corners = [
            quadInfo.quad.topLeftCorner, quadInfo.quad.topRightCorner,
            quadInfo.quad.bottomLeftCorner, quadInfo.quad.bottomRightCorner,
          ]
          const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))))
          const maxX = Math.min(quadInfo.detectionWidth, Math.ceil(Math.max(...corners.map((c) => c.x))))
          const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))))
          const maxY = Math.min(quadInfo.detectionHeight, Math.ceil(Math.max(...corners.map((c) => c.y))))
          const boxWidth = maxX - minX
          const boxHeight = maxY - minY
          if (boxWidth >= 3 && boxHeight >= 3) {
            // detectionCanvasRef, not a fresh crop — Path A (the 90ms tick
            // loop) already redraws it every tick, so this reads whatever
            // frame is currently sitting there rather than re-drawing one.
            const regionData = detectionCanvasRef.current.getContext('2d').getImageData(minX, minY, boxWidth, boxHeight)
            setLiveImageQuality(sharpnessVarianceToPercent(computeSharpnessVariance(regionData)))
          } else {
            setLiveImageQuality(null)
          }
        } else {
          setLiveImageQuality(null)
        }

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
          // Skip (not queue — a stale number-crop isn't worth acting on
          // once a slot frees up later) when the concurrency cap is
          // already full, or scanning is paused (docs/plans/
          // scanner-pause-speed-details.md item 10 — same "suppress only
          // the auto-trigger" rule Path A's own submitCapture guard
          // follows). The streak is left intact rather than reset in
          // either case, so the very next pass — still only
          // ~NUMBER_OCR_INTERVAL_MS away — retries once a slot has
          // hopefully opened (or scanning resumes), instead of losing
          // progress toward the auto-trigger threshold.
          if (activeJobsRef.current.length < MAX_CONCURRENT_JOBS && !scanningPausedRef.current) {
            highConfidenceStreakRef.current = 0
            const snapshot = document.createElement('canvas')
            snapshot.width = cropCanvas.width
            snapshot.height = cropCanvas.height
            snapshot.getContext('2d').drawImage(cropCanvas, 0, 0)
            attemptZoomMatch(snapshot, { number_local })
          }
        }
      } catch {
        // A failed number-OCR pass just retries on the next one — nothing
        // to surface (see docs/plans/scanner-ux-todos.md item 6).
      } finally {
        numberOcrInFlightRef.current = false
      }
    }, NUMBER_OCR_INTERVAL_MS)

    return () => clearInterval(intervalId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cameraStatus])

  // The detection outline is only ever (re)drawn by the hunting-phase tick
  // loop above. Phase 1: that loop no longer stops for a confident
  // background job, so a still-sitting already-captured card's outline
  // now stays live (continuously redrawn, not a frozen stale frame) for as
  // long as it's actually still in frame — this effect's clear only
  // matters for the states that DO still fully stop the loop (ambiguous,
  // error, cameraDenied), so the overlay doesn't show a stale outline
  // behind whichever full-screen view takes over.
  useEffect(() => {
    if (phase === 'hunting') return
    const canvas = overlayCanvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }, [phase])

  // Freeze the visible frame for the camera-denied fallback's own
  // 'processing'/'ambiguous'/'error' states — matches the plan's original
  // "freeze + crop" flow for that single-shot path. Phase 1: a confident
  // live capture never leaves 'hunting' any more, so the video simply
  // never pauses for it at all — continuous by construction, not by a
  // special case here.
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
  const totalScanning = activeJobs.length + queuedCount

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col"
      style={{ background: 'rgba(0,0,0,0.95)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-2 flex-shrink-0">
        <p className="text-[10px] text-text-muted uppercase tracking-[0.2em]">{t('decks.scan.title')}</p>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setShowSettings(true)}
            aria-label={t('decks.scan.settingsTitle')}
            className="w-9 h-9 rounded-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            <Settings size={18} className="text-text-muted" />
          </button>
          <button
            onClick={handleClose}
            aria-label={t('common.close')}
            className="w-9 h-9 rounded-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            <X size={18} className="text-text-muted" />
          </button>
        </div>
      </div>

      {/* Phase 1's only visible sign that background jobs exist at all —
          deliberately just a count, not a per-card status: a positional
          overlay tied to where a card was captured stops meaning anything
          once the user has panned the camera on to the next one. Shown
          regardless of phase (even over the ambiguous/error views) since a
          background job can still be resolving there — see this
          component's own doc comment on that accepted edge case.
          Always mounted at a fixed height, toggled with `invisible` rather
          than conditionally rendered — background jobs starting/finishing
          is the normal, continuous state this feature exists for, and a
          conditionally-rendered row here reflowed the video (and
          everything anchored to it) up/down on every 0-to-1 and 1-to-0
          transition, right as a card was being framed. */}
      <div className={`flex items-center justify-center gap-2 px-4 pb-2 flex-shrink-0 ${totalScanning > 0 ? '' : 'invisible'}`}>
        <Loader2 size={14} className="animate-spin text-brand-red" />
        <p className="text-base text-text-muted">{totalScanning} {t('decks.scan.scanning')}</p>
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

        {(phase === 'hunting' || phase === 'processing' || phase === 'error') && (
          <div className="flex flex-col items-center gap-4 pt-2">
            {/* max-h-[75vh]: aspect-ratio alone only ever derives height
                from width, so on a tall/narrow phone viewport (width is
                the binding constraint, not height) the video stayed
                shorter than the screen had room for — most of that never
                showed anything but the modal's own near-black backdrop.
                Capping height too lets the browser grow the box to
                whichever of the two constraints is tighter, same sizing
                logic as object-fit: contain. */}
            <div className="relative w-full max-w-sm max-h-[75vh] overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: videoAspect }}>
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
                onDecrement={decrementRecentScan}
                onViewDetails={setDetailScan}
                quickAddDisabled={phase !== 'hunting'}
                confirmingKeys={confirmingKeys}
                quickAddLabel={t('decks.scan.quickAdd')}
                removeLabel={t('decks.scan.removeOne')}
                viewDetailsLabel={t('decks.scan.viewScanDetails')}
                t={t}
              />

              {/* Phase 3's Path B live readout — its own pill, not the hint
                  slot below, so it doesn't compete with the single-line
                  hint's own text (see the dynamic hint below). Placed
                  opposite the "Scan now" button (bottom-3) and clear of
                  RecentScansStack (right-2 bottom-2). */}
              {phase === 'hunting' && (liveImageQuality != null || liveNumberText != null) && (
                <div
                  // No quad in frame (e.g. zoomed in past the card's
                  // edges — Path B still reads a number there, just has
                  // nothing to score the image quality of): a neutral
                  // background instead of a quality tier color, since
                  // there's no quality reading to tint by.
                  className={`absolute top-3 left-3 rounded-lg px-2.5 py-1.5 font-mono font-semibold text-black shadow-lg ${liveImageQuality != null ? imageQualityBadgeClass(liveImageQuality) : 'bg-white/90'}`}
                  aria-label={liveImageQuality != null ? `${t('decks.scan.imageQualityLabel')}: ${liveImageQuality}%` : (liveNumberText ?? '')}
                >
                  <div className="text-lg leading-tight">
                    {liveImageQuality != null && `${liveImageQuality}%`}
                    {liveNumberText && `${liveImageQuality != null ? ' — ' : ''}${liveNumberText}`}
                  </div>
                  {liveNamePreview && (
                    <div className="mt-0.5 text-xs font-normal opacity-80">{liveNamePreview}</div>
                  )}
                </div>
              )}

              {/* The failed capture's own thumbnail — bottom-left, mirroring
                  RecentScansStack's bottom-right anchor and matching its
                  h-[120px] thumbnail size, so a real capture always renders
                  at the same size regardless of which corner it's in.
                  Tapping it opens the full-size crop (below, outside this
                  video box so it isn't clipped by its own rounded/
                  overflow-hidden corners). Independent of the bottom-3
                  button row below — sitting in its own corner means it
                  can't shift Try Again off the exact center Scan Now uses,
                  or collide with RecentScansStack in the opposite corner. */}
              {phase === 'error' && errorCardImage && (
                <button
                  type="button"
                  onClick={() => setShowErrorPreview(true)}
                  aria-label={t('decks.scan.viewFailedCapture')}
                  className="absolute left-2 bottom-2 z-10 block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                >
                  <img
                    src={errorCardImage}
                    alt=""
                    className="h-[120px] w-auto rounded-lg border border-white/25 object-contain shadow-lg"
                  />
                </button>
              )}

              {/* Floats over the bottom of the video frame rather than
                  sitting below it in normal flow — on a phone, a
                  portrait-aspect video can fill most of the viewport,
                  pushing anything placed after it below the fold until the
                  user scrolls. This stays reachable the instant hunting
                  starts, no scrolling required. Same slot for 'error''s
                  own primary action (Try Again) — the two phases are
                  mutually exclusive, so there's never a clash.

                  Same fixed spot for both — an earlier attempt only
                  shifted 'hunting' left (and only once a scan existed),
                  which read as the buttons moving between phases; a later
                  attempt centered both plumb dead-center (inset-x-0), but
                  real-device testing found that overlapped
                  RecentScansStack's own "+"/"-" stepper in both phases —
                  worse than visual crowding, since RecentScansStack's z-10
                  (this row has no explicit z-index) means the stack wins
                  hit-testing in the overlap zone: a tap meant for this
                  button could silently land on "-" instead. right-10 (a
                  small, fixed, phase-independent nudge — not the earlier
                  right-[152px], which read as "too far left") clears that
                  overlap while keeping both buttons in the exact same
                  place as each other. */}
              {(phase === 'hunting' || phase === 'error') && (
                <div className="absolute left-0 right-10 bottom-3 flex items-center justify-center pointer-events-none">
                  {phase === 'hunting' && (
                    <button
                      type="button"
                      onClick={handleScanNow}
                      className="btn-primary pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                    >
                      {t('decks.scan.scanNow')}
                    </button>
                  )}
                  {phase === 'error' && (
                    <button
                      type="button"
                      onClick={resetForNextCard}
                      className="btn-primary pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                    >
                      {t('decks.scan.tryAgain')}
                    </button>
                  )}
                </div>
              )}

              {/* Only ever reachable via the camera-denied fallback's own
                  handleManualFile now (Phase 1) — a live capture never sets
                  phase to 'processing' any more. */}
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

              {/* Non-blocking warning toasts (Phase 1) — one per job that
                  resolved not-in-deck/already-complete, stacked rather than
                  a single shared slot, since more than one can genuinely be
                  concurrent now. Floats over the still-live video (never
                  frozen for these, or for anything else, any more) —
                  tappable to dismiss early: WARNING_DURATION_MS is generous
                  specifically because reading it shouldn't be rushed, so
                  the user needs a way to move on sooner once they have.
                  top-20, not top-4: this can now render at the same time as
                  the live-confidence badge (top-3 left-3) — impossible
                  before Phase 1, when a warning only ever showed on the
                  old blocking full-screen flow — and top-4 sat directly on
                  top of the badge's own footprint. */}
              {activeWarnings.length > 0 && (
                <div className="absolute inset-x-0 top-20 z-20 flex flex-col items-center gap-2 px-4 pointer-events-none">
                  {activeWarnings.map((warning) => (
                    <button
                      key={warning.id}
                      type="button"
                      onClick={() => dismissWarningById(warning.id)}
                      className="pointer-events-auto flex max-w-[92%] items-center gap-2 rounded-xl border border-yellow/50 bg-black/85 px-4 py-3 text-left shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/70"
                    >
                      <AlertTriangle size={22} className="flex-shrink-0 text-yellow" aria-hidden />
                      <span className="text-sm font-semibold text-yellow">{warningLabel(warning, t)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {phase === 'hunting' && (
              <p className="text-xs text-text-muted text-center max-w-xs">
                {t('decks.scan.liveHint')}
              </p>
            )}

            {/* confirmError is set by confirmCard/decrementRecentScan's own
                catch blocks — a quick-add or "-" tap (RecentScanThumb) hits
                this exact path while still in 'hunting', not just the
                ambiguous-picker's manual tap below. Without this, a failed
                quick-add previously had no visible feedback at all: the
                thumbnail's spinner just stopped, silently, with the copy
                never actually saved. */}
            {phase === 'hunting' && confirmError && (
              <p className="text-sm text-brand-red text-center max-w-xs">{confirmError}</p>
            )}

            {/* The failed-capture thumbnail and Try Again now live in the
                video's own bottom overlay (same slot as "Scan now") —
                this banner is just the message text. */}
            {phase === 'error' && (
              <div className={`${ERROR_BANNER_CLASS} w-full max-w-sm`}>
                <p className="text-sm text-brand-red">{error}</p>
                {/* totalScanning (defined above, before this return) already
                    excludes this failed job — finishJob runs it out of
                    activeJobs before this catch block's setPhase('error')
                    is ever seen. Without this, a card that failed while a
                    couple of others were still queued/in flight looked like
                    the ENTIRE scanner had stopped, with no sign the rest
                    were still going to land in the recent-scans stack on
                    their own. */}
                {totalScanning > 0 && (
                  <p className="text-xs text-text-muted mt-2">{t('decks.scan.errorOthersStillScanning')}</p>
                )}
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
                <button onClick={resetForNextCard} className="btn-primary mx-auto text-sm">{t('decks.scan.tryAgain')}</button>
              </div>
            )}
            {matches.map((candidate, i) => {
              const key = candidate.id || i
              const isConfirmingThis = confirmingKeys.has(key)
              return (
                <button
                  key={key}
                  type="button"
                  disabled={confirmingKeys.size > 0}
                  onClick={async () => {
                    // Explicit here, not inferred inside confirmCard from
                    // ambient phase — confirmCard is called from several
                    // concurrent places now (Phase 1), so a stale phase
                    // read inside it (this call started while 'ambiguous',
                    // but another background job could change phase again
                    // before this await resolves) could wrongly stomp a
                    // different state. Only THIS call site knows it came
                    // from the ambiguous picker specifically.
                    const saved = await confirmCard(candidate, key, false, result.trace_id, result._identity_decision)
                    if (saved) resetForNextCard()
                  }}
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
              <button onClick={resetForNextCard} disabled={confirmingKeys.size > 0} className="btn-ghost w-full text-sm disabled:cursor-not-allowed disabled:opacity-50">
                {t('decks.scan.scanAnother')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Enlarged failed-capture preview — its own top-level overlay, not
          nested inside the video box, so it isn't clipped by that box's
          own rounded/overflow-hidden corners. Tapping the backdrop closes
          it too, same as the ambiguous-list's own dismiss patterns
          elsewhere in this app. */}
      {showErrorPreview && errorCardImage && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/90 p-6"
          onClick={() => setShowErrorPreview(false)}
        >
          <button
            ref={errorPreviewCloseRef}
            type="button"
            onClick={() => setShowErrorPreview(false)}
            aria-label={t('decks.scan.closeFailedCapturePreview')}
            className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            <X size={18} className="text-text-muted" />
          </button>
          <img
            src={errorCardImage}
            alt=""
            className="max-w-full max-h-full rounded-lg shadow-lg"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}

      {/* Item 8 (docs/plans/scanner-pause-speed-details.md) — reuses the
          same CardModal/selectedCard pattern DeckDetail.jsx already uses
          for browsing deck cards, rather than a new detail viewer.
          `image` falls back to catalog art when this specific scan has no
          real captured photo (a manual ambiguous-list pick, or Path B's
          zoom-match — see addRecentScan's own capturedImage comment).
          overlayClassName is required here — CardModal's underlying
          UnifiedCardDialog defaults to z-50, below this scanner's own
          z-[200] (verified live: without this, the detail view opened but
          rendered completely hidden behind the scanner). z-[300] reuses
          the same tier already established for the settings popup and
          error-preview lightbox above, for the same reason. */}
      {detailScan && (
        <CardModal
          card={detailScan.candidate}
          image={detailScan.capturedImage || detailScan.image}
          onClose={() => setDetailScan(null)}
          defaultLang={detailScan.candidate.lang || 'en'}
          initialTab="overview"
          overlayClassName="z-[300]"
          readOnly
        />
      )}

      {/* Settings popup (docs/plans/scanner-pause-speed-details.md,
          items 10 + Phase 4) — a small floating panel anchored under the
          gear button, NOT the shared ui/Modal.jsx (dropped after
          real-device feedback: Modal's full-screen bg-black/60 backdrop
          hid the live video/outline entirely behind it, so a slider drag
          had no visible feedback until the panel closed — the opposite of
          what an "adjust live and see it move" control needs). The
          backdrop here is a transparent click-catcher only (closes on
          outside tap), not a darkening overlay, so the camera feed and
          the outline stay fully visible while this is open. z-[300]
          matches the tier already used by the error-preview lightbox and
          the tap-for-details view above, for the same "above this
          scanner's own z-[200]" reason. */}
      {showSettings && (
        <div className="fixed inset-0 z-[300]" onClick={() => setShowSettings(false)}>
          <div
            className="absolute top-16 right-3 w-72 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-white/10 shadow-xl p-5 space-y-5"
            style={{ background: 'rgba(15,15,26,0.95)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-text-primary">{t('decks.scan.settingsTitle')}</p>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                aria-label={t('common.close')}
                className="w-7 h-7 rounded-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                style={{ background: 'rgba(255,255,255,0.08)' }}
              >
                <X size={14} className="text-text-muted" />
              </button>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">{t('decks.scan.pauseScanning')}</p>
                <p className="text-xs text-text-muted mt-0.5">{t('decks.scan.pauseScanningHint')}</p>
              </div>
              <button
                type="button"
                onClick={() => setScanningPaused((current) => !current)}
                aria-pressed={scanningPaused}
                aria-label={t('decks.scan.pauseScanning')}
                className={`relative w-11 h-6 flex-shrink-0 rounded-full transition-colors duration-200 ${
                  scanningPaused ? 'bg-brand-red' : 'bg-bg-elevated border border-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                    scanningPaused ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary mb-2">{t('decks.scan.outlineTrackingSpeed')}</p>
              {/* onChange (not a separate "apply" step) fires setSmoothingSpeedIndex
                  immediately, which smoothingSpeedIndexRef's own sync
                  effect picks up before the tick loop's very next 90ms
                  tick — the outline visibly changes speed while this
                  panel is still open, not just after closing it. */}
              <input
                type="range"
                min="0"
                max={OVERLAY_SMOOTHING_ALPHA_VALUES.length - 1}
                step="1"
                value={smoothingSpeedIndex}
                onChange={(event) => {
                  const newIndex = Number(event.target.value)
                  setSmoothingSpeedIndex(newIndex)
                  setStoredSmoothingSpeedIndex(newIndex)
                }}
                aria-label={t('decks.scan.outlineTrackingSpeed')}
                className="scanner-speed-slider w-full h-9 accent-brand-red"
              />
              <div className="flex items-center justify-between text-xs text-text-muted mt-1">
                <span>{t('decks.scan.smootherLabel')}</span>
                <span>{t('decks.scan.fasterLabel')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
