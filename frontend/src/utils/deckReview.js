// Pure helpers for the AddDeck review step — kept separate from the page so
// the parsed-entry review/correction logic (quantity clamping, resolution
// counting, per-entry updates) is unit-testable without rendering React.

export function clampDeckEntryQuantity(value) {
  return Math.min(99, Math.max(1, Number(value) || 1))
}

export function countUnresolvedEntries(entries) {
  return entries.filter(entry => !entry.card_id).length
}

export function setEntryCard(entries, index, card) {
  return entries.map((entry, i) => (
    i === index ? { ...entry, card_id: card.id, card, confident: true } : entry
  ))
}

export function setEntryQuantity(entries, index, quantity) {
  const safeQuantity = clampDeckEntryQuantity(quantity)
  return entries.map((entry, i) => (
    i === index ? { ...entry, expected_quantity: safeQuantity } : entry
  ))
}
