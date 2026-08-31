import { describe, expect, it } from 'vitest'
import { computeNumberBandRect } from './numberBand'

function quadAt(x, y, w, h) {
  return {
    topLeftCorner: { x, y },
    topRightCorner: { x: x + w, y },
    bottomLeftCorner: { x, y: y + h },
    bottomRightCorner: { x: x + w, y: y + h },
  }
}

describe('computeNumberBandRect', () => {
  it('crops a bottom band of the quad when one is present', () => {
    const rect = computeNumberBandRect(1000, 1000, quadAt(100, 100, 400, 600))
    // Bottom edge of the crop matches the bottom edge of the quad
    // (100 + 600 = 700) — collector numbers print near the card's bottom.
    expect(rect.y + rect.height).toBeCloseTo(700)
    expect(rect.height).toBeLessThan(600)
    expect(rect.width).toBeLessThan(400)
  })

  it('widens the quad band on later fallback levels', () => {
    const level0 = computeNumberBandRect(1000, 1000, quadAt(100, 100, 400, 600), 0)
    const level1 = computeNumberBandRect(1000, 1000, quadAt(100, 100, 400, 600), 1)
    const level2 = computeNumberBandRect(1000, 1000, quadAt(100, 100, 400, 600), 2)

    expect(level1.width).toBeGreaterThan(level0.width)
    expect(level1.height).toBe(level0.height)
    expect(level2.height).toBeGreaterThan(level1.height)
  })

  it('falls back to a bounded region of the raw frame with no quad at all', () => {
    const rect = computeNumberBandRect(1000, 800, null, 0)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(1000)
    expect(rect.y + rect.height).toBeLessThanOrEqual(800)
    // Level 0 should be a genuine sub-region, not the whole frame.
    expect(rect.width).toBeLessThan(1000)
  })

  it('widens the no-quad band as the fallback level increases', () => {
    const level0 = computeNumberBandRect(1000, 800, null, 0)
    const level1 = computeNumberBandRect(1000, 800, null, 1)
    const level2 = computeNumberBandRect(1000, 800, null, 2)

    expect(level1.width * level1.height).toBeGreaterThan(level0.width * level0.height)
    expect(level2.width * level2.height).toBeGreaterThan(level1.width * level1.height)
  })

  it('reaches the full frame at the maximum no-quad fallback level, clamping beyond it', () => {
    const atMax = computeNumberBandRect(1000, 800, null, 2)
    const beyondMax = computeNumberBandRect(1000, 800, null, 5)
    expect(atMax).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
    expect(beyondMax).toEqual(atMax)
  })
})
