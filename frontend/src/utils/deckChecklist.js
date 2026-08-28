// Pure helpers for the DeckDetail missing-cards checklist — filtering,
// sorting, and the missing-quantity calculation, kept separate from the page
// so they're unit-testable without rendering React.

export function missingQuantity(deckCard) {
  return deckCard.expected_quantity - deckCard.scanned_quantity
}

export function isDeckCardMissing(deckCard) {
  return deckCard.scanned_quantity < deckCard.expected_quantity
}

export function byCardName(a, b) {
  return String(a.card?.name || '').localeCompare(String(b.card?.name || ''), undefined, { sensitivity: 'base', numeric: true })
}

export function selectVisibleDeckCards(cards, filter) {
  const filtered = filter === 'missing'
    ? cards.filter(isDeckCardMissing)
    : filter === 'found'
      ? cards.filter(card => !isDeckCardMissing(card))
      : cards
  return filtered.slice().sort(byCardName)
}
