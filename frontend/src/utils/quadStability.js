// Pure helpers for deciding whether a detected card outline has been held
// still long enough to capture — kept separate from cardDetection.js (which
// needs a real OpenCV.js/DOM environment) so this logic is unit-testable.
//
// A quad is {topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner},
// each {x, y} in the source frame's pixel space — matches jscanify's
// getCornerPoints() shape.

const CORNER_KEYS = ['topLeftCorner', 'topRightCorner', 'bottomLeftCorner', 'bottomRightCorner']

export function isCompleteQuad(quad) {
  return Boolean(quad) && CORNER_KEYS.every((key) => (
    quad[key] && Number.isFinite(quad[key].x) && Number.isFinite(quad[key].y)
  ))
}

function cornerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// Two quads count as "the same card, held still" if every corresponding
// corner moved less than toleranceProportion of the frame's shorter side —
// a fixed pixel tolerance would be too loose on a low-res feed and too
// tight on a high-res one.
export function quadsAreStable(previous, current, frameWidth, frameHeight, toleranceProportion = 0.02) {
  if (!isCompleteQuad(previous) || !isCompleteQuad(current)) return false
  const tolerance = Math.min(frameWidth, frameHeight) * toleranceProportion
  return CORNER_KEYS.every((key) => cornerDistance(previous[key], current[key]) <= tolerance)
}

// Tracks consecutive stable readings across detection ticks and reports
// whether a capture should fire. A plain factory-returned object (not a
// class) so callers can hold it in a ref without worrying about `this`.
export function createStabilityTracker({ requiredConsecutiveFrames = 5, toleranceProportion = 0.02 } = {}) {
  let lastQuad = null
  let consecutiveStableFrames = 0

  return {
    // Feed one detection tick's result (a quad, or null when nothing was
    // found). Returns whether this reading was stable against the previous
    // one, the current streak length, and whether the streak just reached
    // the capture threshold.
    observe(quad, frameWidth, frameHeight) {
      if (!isCompleteQuad(quad)) {
        lastQuad = null
        consecutiveStableFrames = 0
        return { stable: false, consecutiveStableFrames: 0, readyToCapture: false }
      }

      const stableAgainstLast = quadsAreStable(lastQuad, quad, frameWidth, frameHeight, toleranceProportion)
      consecutiveStableFrames = stableAgainstLast ? consecutiveStableFrames + 1 : 1
      lastQuad = quad

      return {
        stable: stableAgainstLast,
        consecutiveStableFrames,
        readyToCapture: consecutiveStableFrames >= requiredConsecutiveFrames,
      }
    },

    reset() {
      lastQuad = null
      consecutiveStableFrames = 0
    },
  }
}
