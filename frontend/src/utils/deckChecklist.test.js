import { describe, expect, it } from 'vitest'
import { byCardName, isDeckCardMissing, missingQuantity, selectVisibleDeckCards } from './deckChecklist'

const deckCards = [
  { card_id: 'sv1-2_en', card: { name: 'Floragato' }, expected_quantity: 2, scanned_quantity: 2 },
  { card_id: 'sv1-1_en', card: { name: 'Sprigatito' }, expected_quantity: 1, scanned_quantity: 0 },
  { card_id: 'sv1-3_en', card: { name: 'Meowscarada' }, expected_quantity: 3, scanned_quantity: 1 },
]

describe('missingQuantity', () => {
  it('is expected minus scanned', () => {
    expect(missingQuantity({ expected_quantity: 3, scanned_quantity: 1 })).toBe(2)
    expect(missingQuantity({ expected_quantity: 1, scanned_quantity: 1 })).toBe(0)
  })
})

describe('isDeckCardMissing', () => {
  it('is true only while scanned is below expected', () => {
    expect(isDeckCardMissing({ expected_quantity: 2, scanned_quantity: 1 })).toBe(true)
    expect(isDeckCardMissing({ expected_quantity: 2, scanned_quantity: 2 })).toBe(false)
    // A scan session that (via the backend's own cap) never exceeds expected,
    // but guard the boundary here too rather than assume that invariant.
    expect(isDeckCardMissing({ expected_quantity: 2, scanned_quantity: 3 })).toBe(false)
  })
})

describe('byCardName', () => {
  it('sorts alphabetically by the nested card name', () => {
    const sorted = [...deckCards].sort(byCardName)
    expect(sorted.map(c => c.card.name)).toEqual(['Floragato', 'Meowscarada', 'Sprigatito'])
  })
})

describe('selectVisibleDeckCards', () => {
  it('filters to only missing cards, sorted by name', () => {
    const result = selectVisibleDeckCards(deckCards, 'missing')
    expect(result.map(c => c.card.name)).toEqual(['Meowscarada', 'Sprigatito'])
  })

  it('filters to only found cards, sorted by name', () => {
    const result = selectVisibleDeckCards(deckCards, 'found')
    expect(result.map(c => c.card.name)).toEqual(['Floragato'])
  })

  it('returns every card, sorted by name, for "all"', () => {
    const result = selectVisibleDeckCards(deckCards, 'all')
    expect(result.map(c => c.card.name)).toEqual(['Floragato', 'Meowscarada', 'Sprigatito'])
  })

  it('does not mutate the input array', () => {
    const original = [...deckCards]
    selectVisibleDeckCards(deckCards, 'all')
    expect(deckCards).toEqual(original)
  })
})
