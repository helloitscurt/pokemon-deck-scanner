// Computes the crop rectangle for Phase 3's throttled number-only OCR pass
// (docs/plans/live-card-scanner.md's Path B) — pure coordinate math, no
// canvas/DOM access, mirroring quadStability.js's own split of "pure,
// unit-testable" math from the component that actually draws pixels.
//
// No perspective correction here: extractCard/scanner.extractPaper needs 4
// corner points and can't run without a quad at all, so Path B (which
// mainly fires with NO quad — zoomed in past the card's edges) never uses
// it. A plain axis-aligned crop is enough since the user is framing the
// number directly.

// Bottom-band heuristic for when a quad exists — mirrors cardOcr.js's own
// top-band NAME_BAND_FRACTION heuristic for the name, but at the bottom,
// where collector numbers are usually printed. Reasoned starting point,
// not empirically calibrated against real cards yet — same caveat
// NAME_BAND_FRACTION itself carries.
const NUMBER_BAND_HEIGHT_FRACTION = 0.16
const NUMBER_BAND_WIDTH_FRACTION = 0.55

// No quad in frame (Path B's main case). Baseline guesses a bottom-left-ish
// region of the raw frame; each fallback level widens it so a nonstandard
// number position doesn't get stuck reading nothing forever (see the
// plan's Risks: "Number-band heuristic reliability").
const NO_QUAD_BANDS = [
  { x: 0, yFraction: 0.55, widthFraction: 0.65, heightFraction: 0.45 },
  { x: 0, yFraction: 0.35, widthFraction: 1, heightFraction: 0.65 },
  { x: 0, yFraction: 0, widthFraction: 1, heightFraction: 1 },
]

// sourceWidth/sourceHeight: pixel dimensions of the frame being cropped
// from. quad: a {topLeftCorner, topRightCorner, bottomLeftCorner,
// bottomRightCorner} reading (cardDetection.js's shape) or null/undefined.
// fallbackLevel: 0 (tightest guess) up to NO_QUAD_BANDS.length - 1
// (widest), clamped. Returns {x, y, width, height} in source pixel space.
export function computeNumberBandRect(sourceWidth, sourceHeight, quad, fallbackLevel = 0) {
  const level = Math.max(0, Math.min(NO_QUAD_BANDS.length - 1, fallbackLevel))

  if (quad) {
    const xs = [quad.topLeftCorner.x, quad.topRightCorner.x, quad.bottomLeftCorner.x, quad.bottomRightCorner.x]
    const ys = [quad.topLeftCorner.y, quad.topRightCorner.y, quad.bottomLeftCorner.y, quad.bottomRightCorner.y]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const quadWidth = maxX - minX
    const quadHeight = maxY - minY
    // Widen to the quad's full width at level 1, full height too at level 2
    // — same "widen every fallback pass" idea as the no-quad bands below.
    const widthFraction = level >= 1 ? 1 : NUMBER_BAND_WIDTH_FRACTION
    const heightFraction = level >= 2 ? 1 : NUMBER_BAND_HEIGHT_FRACTION
    return {
      x: minX,
      y: maxY - quadHeight * heightFraction,
      width: quadWidth * widthFraction,
      height: quadHeight * heightFraction,
    }
  }

  const band = NO_QUAD_BANDS[level]
  return {
    x: band.x * sourceWidth,
    y: band.yFraction * sourceHeight,
    width: band.widthFraction * sourceWidth,
    height: band.heightFraction * sourceHeight,
  }
}
