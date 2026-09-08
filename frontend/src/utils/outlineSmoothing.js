// Device-local outline-tracking-speed setting (docs/plans/scanner-pause-speed-details.md)
// — how fast DeckCardScanner.jsx's drawn detection outline follows the raw
// detected quad each tick, exposed as a 5-position slider. Plain
// localStorage get/set, no wrapper library, matching this codebase's own
// convention (see useTheme.js).

// 0.42 (index 2) is today's shipped OVERLAY_SMOOTHING_ALPHA — the middle
// value, so a user who never opens the slider sees identical behavior.
// Step of 0.06 deliberately extends past both ends of what was already
// real-device tested this session (0.35 read as "too slow," 0.5 as "too
// jumpy," 0.42 as the settled middle), so the two extremes here are
// genuinely further in each direction than anything tried so far.
export const OVERLAY_SMOOTHING_ALPHA_VALUES = [0.30, 0.36, 0.42, 0.48, 0.54]
export const DEFAULT_SMOOTHING_SPEED_INDEX = 2

const STORAGE_KEY = 'scannerSmoothingSpeedIndex'

// Validates the stored value is a genuine index into
// OVERLAY_SMOOTHING_ALPHA_VALUES — a corrupted/hand-edited/pre-this-feature
// localStorage value falls back to the default rather than producing an
// out-of-range alpha.
export function getStoredSmoothingSpeedIndex() {
  const raw = localStorage.getItem(STORAGE_KEY)
  // raw is null when nothing is stored — checked explicitly before
  // Number(), since Number(null) is 0 (a valid-looking index), not NaN,
  // which would otherwise silently treat "nothing stored" as index 0
  // (alpha 0.30) instead of falling through to the real default below.
  if (raw === null) return DEFAULT_SMOOTHING_SPEED_INDEX
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= OVERLAY_SMOOTHING_ALPHA_VALUES.length) {
    return DEFAULT_SMOOTHING_SPEED_INDEX
  }
  return parsed
}

export function setStoredSmoothingSpeedIndex(index) {
  localStorage.setItem(STORAGE_KEY, String(index))
}
