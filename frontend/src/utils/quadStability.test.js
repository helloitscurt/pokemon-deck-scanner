import { describe, expect, it } from 'vitest'
import { createStabilityTracker, isCompleteQuad, quadsAreStable } from './quadStability'

function quadAt(x, y, size = 100) {
  return {
    topLeftCorner: { x, y },
    topRightCorner: { x: x + size, y },
    bottomLeftCorner: { x, y: y + size },
    bottomRightCorner: { x: x + size, y: y + size },
  }
}

describe('isCompleteQuad', () => {
  it('is false for null/undefined', () => {
    expect(isCompleteQuad(null)).toBe(false)
    expect(isCompleteQuad(undefined)).toBe(false)
  })

  it('is false when a corner is missing', () => {
    const { bottomRightCorner, ...missingOne } = quadAt(0, 0)
    expect(isCompleteQuad(missingOne)).toBe(false)
  })

  it('is false when a corner has a non-finite coordinate', () => {
    const quad = quadAt(0, 0)
    quad.topLeftCorner = { x: NaN, y: 0 }
    expect(isCompleteQuad(quad)).toBe(false)
  })

  it('is true for a fully populated quad', () => {
    expect(isCompleteQuad(quadAt(10, 10))).toBe(true)
  })
})

describe('quadsAreStable', () => {
  it('is false when either quad is missing', () => {
    expect(quadsAreStable(null, quadAt(0, 0), 400, 400)).toBe(false)
    expect(quadsAreStable(quadAt(0, 0), null, 400, 400)).toBe(false)
  })

  it('is true when every corner moved less than the tolerance', () => {
    const previous = quadAt(100, 100)
    const current = quadAt(101, 101) // ~1.4px of drift per corner
    expect(quadsAreStable(previous, current, 400, 400, 0.02)).toBe(true) // tolerance = 8px
  })

  it('is false when any corner moved past the tolerance', () => {
    const previous = quadAt(100, 100)
    const current = quadAt(120, 100) // top-left moved 20px
    expect(quadsAreStable(previous, current, 400, 400, 0.02)).toBe(false) // tolerance = 8px
  })

  it('scales the tolerance to the frame\'s shorter side', () => {
    const previous = quadAt(100, 100)
    const current = quadAt(105, 100) // 5px drift
    // 400x400 frame: tolerance = 8px -> stable
    expect(quadsAreStable(previous, current, 400, 400, 0.02)).toBe(true)
    // 100x100 frame: tolerance = 2px -> not stable
    expect(quadsAreStable(previous, current, 100, 100, 0.02)).toBe(false)
  })
})

describe('createStabilityTracker', () => {
  it('is not ready to capture on the first reading', () => {
    const tracker = createStabilityTracker({ requiredConsecutiveFrames: 3 })
    const result = tracker.observe(quadAt(0, 0), 400, 400)
    expect(result).toEqual({ stable: false, consecutiveStableFrames: 1, readyToCapture: false })
  })

  it('reaches readyToCapture once the same quad holds for the required streak', () => {
    const tracker = createStabilityTracker({ requiredConsecutiveFrames: 3 })
    tracker.observe(quadAt(0, 0), 400, 400)
    const second = tracker.observe(quadAt(1, 1), 400, 400)
    expect(second.readyToCapture).toBe(false)
    const third = tracker.observe(quadAt(2, 1), 400, 400)
    expect(third).toEqual({ stable: true, consecutiveStableFrames: 3, readyToCapture: true })
  })

  it('resets the streak when the quad jumps', () => {
    const tracker = createStabilityTracker({ requiredConsecutiveFrames: 3 })
    tracker.observe(quadAt(0, 0), 400, 400)
    tracker.observe(quadAt(1, 1), 400, 400)
    const jumped = tracker.observe(quadAt(300, 300), 400, 400)
    expect(jumped.stable).toBe(false)
    expect(jumped.consecutiveStableFrames).toBe(1)
  })

  it('resets the streak to zero when nothing is detected', () => {
    const tracker = createStabilityTracker({ requiredConsecutiveFrames: 3 })
    tracker.observe(quadAt(0, 0), 400, 400)
    tracker.observe(quadAt(1, 1), 400, 400)
    const lost = tracker.observe(null, 400, 400)
    expect(lost).toEqual({ stable: false, consecutiveStableFrames: 0, readyToCapture: false })

    // and the streak genuinely restarts, not just reports zero once
    const next = tracker.observe(quadAt(0, 0), 400, 400)
    expect(next.consecutiveStableFrames).toBe(1)
  })

  it('reset() clears an in-progress streak the same way losing detection does', () => {
    const tracker = createStabilityTracker({ requiredConsecutiveFrames: 3 })
    tracker.observe(quadAt(0, 0), 400, 400)
    tracker.observe(quadAt(1, 1), 400, 400)
    tracker.reset()
    const afterReset = tracker.observe(quadAt(1, 1), 400, 400)
    expect(afterReset.consecutiveStableFrames).toBe(1)
  })
})
