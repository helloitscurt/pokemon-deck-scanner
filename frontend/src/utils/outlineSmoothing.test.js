// @vitest-environment jsdom
//
// Needs a real localStorage global, unlike this codebase's other pure-math
// util tests (imageSharpness.test.js, quadStability.test.js) which don't
// need a DOM environment at all.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SMOOTHING_SPEED_INDEX,
  OVERLAY_SMOOTHING_ALPHA_VALUES,
  getStoredSmoothingSpeedIndex,
  setStoredSmoothingSpeedIndex,
} from './outlineSmoothing'

describe('OVERLAY_SMOOTHING_ALPHA_VALUES', () => {
  it('has 5 values with the default index pointing at today\'s shipped alpha (0.42)', () => {
    expect(OVERLAY_SMOOTHING_ALPHA_VALUES).toHaveLength(5)
    expect(OVERLAY_SMOOTHING_ALPHA_VALUES[DEFAULT_SMOOTHING_SPEED_INDEX]).toBe(0.42)
  })
})

describe('getStoredSmoothingSpeedIndex/setStoredSmoothingSpeedIndex', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('defaults to DEFAULT_SMOOTHING_SPEED_INDEX when nothing is stored', () => {
    expect(getStoredSmoothingSpeedIndex()).toBe(DEFAULT_SMOOTHING_SPEED_INDEX)
  })

  it('round-trips a stored value', () => {
    setStoredSmoothingSpeedIndex(4)
    expect(getStoredSmoothingSpeedIndex()).toBe(4)
  })

  it('falls back to the default for a non-numeric stored value', () => {
    localStorage.setItem('scannerSmoothingSpeedIndex', 'not-a-number')
    expect(getStoredSmoothingSpeedIndex()).toBe(DEFAULT_SMOOTHING_SPEED_INDEX)
  })

  it('falls back to the default for an out-of-range stored index', () => {
    localStorage.setItem('scannerSmoothingSpeedIndex', '99')
    expect(getStoredSmoothingSpeedIndex()).toBe(DEFAULT_SMOOTHING_SPEED_INDEX)

    localStorage.setItem('scannerSmoothingSpeedIndex', '-1')
    expect(getStoredSmoothingSpeedIndex()).toBe(DEFAULT_SMOOTHING_SPEED_INDEX)
  })

  it('falls back to the default for a non-integer stored value', () => {
    localStorage.setItem('scannerSmoothingSpeedIndex', '2.5')
    expect(getStoredSmoothingSpeedIndex()).toBe(DEFAULT_SMOOTHING_SPEED_INDEX)
  })
})
