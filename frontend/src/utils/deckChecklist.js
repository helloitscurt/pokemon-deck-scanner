// Pure helpers for the DeckDetail missing-cards checklist — filtering,
// sorting, and the missing-quantity calculation, kept separate from the page
// so they're unit-testable without rendering React.

export function missingQuantity(deckCard) {
  return deckCard.expected_quantity - deckCard.scanned_quantity
}

export function isDeckCardMissing(deckCard) {
  return deckCard.scanned_quantity < deckCard.expected_quantity
}

// "Found" means at least one copy has been scanned — not "every copy has
// been scanned". A card needing 4 copies with 1 scanned is both still
// Missing (3 more needed) and already Found (you have located one) — these
// two tabs deliberately overlap rather than partition the deck, so a card
// you've made partial progress on shows up in both instead of neither.
export function isDeckCardFound(deckCard) {
  return deckCard.scanned_quantity > 0
}

export function byCardName(a, b) {
  return String(a.card?.name || '').localeCompare(String(b.card?.name || ''), undefined, { sensitivity: 'base', numeric: true })
}

// Highest missing quantity first; ties broken alphabetically so the order is
// still predictable when several cards need the same number of copies.
export function byMissingDesc(a, b) {
  const diff = missingQuantity(b) - missingQuantity(a)
  return diff !== 0 ? diff : byCardName(a, b)
}

// Card numbers are usually plain digits ("109") but can have a letter prefix
// or suffix ("TG01", "4a") — sort by the leading numeric run, then fall back
// to a plain string compare for whatever's left (mirrors the natural-sort
// approach already used for set checklists elsewhere in this app).
export function byCardNumberAsc(a, b) {
  const numberA = String(a.card?.number ?? '')
  const numberB = String(b.card?.number ?? '')
  const leadingDigits = (value) => {
    const match = value.match(/^\d+/)
    return match ? parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER
  }
  const diff = leadingDigits(numberA) - leadingDigits(numberB)
  return diff !== 0 ? diff : numberA.localeCompare(numberB, undefined, { numeric: true })
}

export const DECK_CHECKLIST_SORTS = {
  missing_desc: byMissingDesc,
  alphabetical: byCardName,
  number_asc: byCardNumberAsc,
}

export function selectVisibleDeckCards(cards, filter, sortBy = 'missing_desc') {
  const filtered = filter === 'missing'
    ? cards.filter(isDeckCardMissing)
    : filter === 'found'
      ? cards.filter(isDeckCardFound)
      : cards
  const comparator = DECK_CHECKLIST_SORTS[sortBy] || byMissingDesc
  return filtered.slice().sort(comparator)
}
