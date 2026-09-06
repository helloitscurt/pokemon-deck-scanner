import { describe, expect, it } from 'vitest'
import { computeSharpnessVariance, sharpnessVarianceToPercent } from './imageSharpness'

// Builds a plain {data, width, height} imageData-shaped object — a flat
// color everywhere except one alternating checkerboard pixel per 2x2 block
// when `sharp` is true, mimicking real high-frequency edge content versus a
// uniformly blurred/flat crop.
function makeImageData(width, height, { sharp }) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const isEdge = sharp && (x + y) % 2 === 0
      const value = isEdge ? 255 : 0
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}

function makeFlatImageData(width, height, value = 128) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }
  return { data, width, height }
}

describe('computeSharpnessVariance', () => {
  it('reads a high variance for a high-contrast checkerboard (sharp edges)', () => {
    const sharp = makeImageData(20, 20, { sharp: true })
    expect(computeSharpnessVariance(sharp)).toBeGreaterThan(1000)
  })

  it('reads zero variance for a perfectly flat, uniform region (no edges at all)', () => {
    const flat = makeFlatImageData(20, 20)
    expect(computeSharpnessVariance(flat)).toBe(0)
  })

  it('reads a lower variance for flat data than for sharp data of the same size', () => {
    const sharp = computeSharpnessVariance(makeImageData(20, 20, { sharp: true }))
    const flat = computeSharpnessVariance(makeFlatImageData(20, 20))
    expect(flat).toBeLessThan(sharp)
  })

  it('returns 0 for a region too small to convolve', () => {
    expect(computeSharpnessVariance(makeFlatImageData(2, 2))).toBe(0)
    expect(computeSharpnessVariance({ data: null, width: 0, height: 0 })).toBe(0)
  })
})

describe('sharpnessVarianceToPercent', () => {
  it('maps 0 variance to 0%', () => {
    expect(sharpnessVarianceToPercent(0)).toBe(0)
  })

  it('clamps a variance at or past the ceiling to 100%, never overflowing', () => {
    expect(sharpnessVarianceToPercent(400)).toBe(100)
    expect(sharpnessVarianceToPercent(1_000_000)).toBe(100)
  })

  it('scales linearly between the two ends', () => {
    expect(sharpnessVarianceToPercent(200)).toBe(50)
  })

  it('never returns a negative percentage for a negative input', () => {
    expect(sharpnessVarianceToPercent(-50)).toBe(0)
  })
})
