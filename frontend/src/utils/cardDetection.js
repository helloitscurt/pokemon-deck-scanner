// Lazy-loads the vendored OpenCV.js + jscanify (frontend/public/opencv/,
// see VENDORED.md) on first use and exposes a small card-detection API.
//
// Built directly on jscanify's lower-level findPaperContour/getCornerPoints
// rather than its highlightPaper convenience method: highlightPaper reruns
// detection AND draws an outline onto a brand-new canvas every call, which
// this app doesn't need (DeckCardScanner draws its own overlay, in its own
// colors per detection state, from the corners returned below) — calling it
// on every detection tick would mean running contour detection twice per
// tick for no benefit. It also never deletes the contour Mat it computes,
// which leaks in a loop that runs 5-6x/sec continuously; deleting it
// ourselves below avoids that.

let readyPromise = null

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.body.appendChild(script)
  })
}

// Resolves to a jscanify instance once window.cv is fully initialized.
// Cached as a singleton promise so repeated calls (every detection tick,
// or an explicit preload) only ever load/init once per page load — but
// only the successful case is cached. A transient failure (e.g. a network
// blip while the scanner opens) must not permanently wedge every future
// call for the rest of the page's lifetime with the same stale rejection.
function ensureReady() {
  if (!readyPromise) {
    readyPromise = loadScript('/opencv/opencv.js')
      .then(() => new Promise((resolve) => {
        window.cv['onRuntimeInitialized'] = resolve
      }))
      .then(() => loadScript('/opencv/jscanify.js'))
      .then(() => new window.jscanify())
      .catch((err) => {
        readyPromise = null
        throw err
      })
  }
  return readyPromise
}

// Starts loading OpenCV.js/jscanify ahead of the first detection tick, so
// the scanner doesn't stall on frame one while ~10MB of WASM downloads.
// Safe to call more than once; failures surface later, at the first real
// detectCardQuad/extractCard call, not here.
export function preloadCardDetection() {
  ensureReady().catch(() => {})
}

// Detects a card-shaped quadrilateral in one frame (a <canvas> or <video>
// element). Returns {topLeftCorner, topRightCorner, bottomLeftCorner,
// bottomRightCorner} — each {x, y} in source's pixel space, the shape
// quadStability.js expects — or null if nothing was found.
export async function detectCardQuad(source) {
  const scanner = await ensureReady()
  const cv = window.cv
  const img = cv.imread(source)
  try {
    const contour = scanner.findPaperContour(img)
    if (!contour) return null
    try {
      const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } =
        scanner.getCornerPoints(contour)
      if (!topLeftCorner || !topRightCorner || !bottomLeftCorner || !bottomRightCorner) {
        return null
      }
      return { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner }
    } finally {
      contour.delete()
    }
  } finally {
    img.delete()
  }
}

// Perspective-corrects and crops source to a resultWidth x resultHeight
// canvas using cornerPoints from a prior detectCardQuad call — pass the
// STABLE reading, not a fresh detection, so the crop matches exactly what
// the stability check confirmed. Returns an HTMLCanvasElement.
export async function extractCard(source, resultWidth, resultHeight, cornerPoints) {
  const scanner = await ensureReady()
  return scanner.extractPaper(source, resultWidth, resultHeight, cornerPoints)
}
