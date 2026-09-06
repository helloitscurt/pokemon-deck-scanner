// Laplacian-variance sharpness/focus estimate for a cropped region of a
// video frame (docs/plans/scanner-ux-todos.md item 7) — replaces the old
// live badge's OCR-confidence reading, which measured how readable the
// collector number was, not whether the photo itself was in focus (a
// number can OCR confidently on a blurry photo, and read low-confidence on
// a sharp one if the number itself is small or worn). Laplacian variance
// is a classic no-reference blur metric: convolve grayscale pixel values
// with a discrete Laplacian kernel and take the variance of the result — a
// sharp, in-focus image has strong edges (high variance); a blurry one
// doesn't. Pure pixel-data math, no canvas/DOM/OpenCV access, mirroring
// numberBand.js/quadStability.js's own split of "pure, unit-testable" math
// from the component that actually reads pixels.

// Reasoned starting point, not empirically calibrated against real
// devices/cameras yet — same caveat every other tuning constant in this
// scanner carries. Raw Laplacian variance has no natural upper bound (it
// scales with contrast and resolution, not just focus), so this is the
// "clearly sharp" ceiling the 0-100 display percentage is normalized
// against below, not a hard physical limit.
const SHARPNESS_VARIANCE_CEILING = 400

// imageData: a CanvasRenderingContext2D getImageData() result (or any
// plain {data, width, height} with the same shape). Returns the raw
// Laplacian variance — higher is sharper — or 0 for a region too small to
// convolve (a 1px sliver at the very edge of a frame, say).
export function computeSharpnessVariance(imageData) {
  const { data, width, height } = imageData
  if (!data || width < 3 || height < 3) return 0

  // Grayscale via standard luminance weights, into a plain typed array so
  // the convolution below doesn't re-derive it per neighbor.
  const gray = new Float32Array(width * height)
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
  }

  let sum = 0
  let sumSq = 0
  let count = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      // Discrete Laplacian kernel: [[0,1,0],[1,-4,1],[0,1,0]].
      const value = gray[idx - 1] + gray[idx + 1] + gray[idx - width] + gray[idx + width] - 4 * gray[idx]
      sum += value
      sumSq += value * value
      count++
    }
  }
  if (count === 0) return 0
  const mean = sum / count
  return sumSq / count - mean * mean
}

// Maps a raw variance reading to a 0-100 display percentage against
// SHARPNESS_VARIANCE_CEILING — see its own comment on why this is a
// reasoned scale, not a calibrated one. Clamped both ends: variance is
// never negative, but a value past the ceiling should still read 100, not
// overflow the display.
export function sharpnessVarianceToPercent(variance) {
  return Math.max(0, Math.min(100, Math.round((variance / SHARPNESS_VARIANCE_CEILING) * 100)))
}
