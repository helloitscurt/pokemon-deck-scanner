import { describe, expect, it } from 'vitest'
import {
  byCardName,
  byCardNumberAsc,
  byMissingDesc,
  isDeckCardFound,
  isDeckCardMissing,
  missingQuantity,
  selectVisibleDeckCards,
} from './deckChecklist'

const deckCards = [
  { card_id: 'sv1-2_en', card: { name: 'Floragato', number: '2' }, expected_quantity: 2, scanned_quantity: 2 },
  { card_id: 'sv1-1_en', card: { name: 'Sprigatito', number: '1' }, expected_quantity: 1, scanned_quantity: 0 },
  { card_id: 'sv1-3_en', card: { name: 'Meowscarada', number: '10' }, expected_quantity: 3, scanned_quantity: 1 },
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

describe('isDeckCardFound', () => {
  it('is true once at least one copy is scanned, even if more are still needed', () => {
    // Regression test: a card needing 4 copies with 1 scanned must show up
    // under Found (you have found one) as well as under Missing (you still
    // need 3 more) — these two tabs overlap on purpose, they don't partition
    // the deck. Found used to mean "fully complete", which left a partially
    // scanned card invisible in the Found tab even though its own row
    // correctly showed partial progress ("3/4 missing").
    expect(isDeckCardFound({ expected_quantity: 4, scanned_quantity: 1 })).toBe(true)
    expect(isDeckCardFound({ expected_quantity: 4, scanned_quantity: 0 })).toBe(false)
    expect(isDeckCardFound({ expected_quantity: 1, scanned_quantity: 1 })).toBe(true)
  })
})

describe('byCardName', () => {
  it('sorts alphabetically by the nested card name', () => {
    const sorted = [...deckCards].sort(byCardName)
    expect(sorted.map(c => c.card.name)).toEqual(['Floragato', 'Meowscarada', 'Sprigatito'])
  })
})

describe('byMissingDesc', () => {
  it('sorts by highest missing quantity first', () => {
    const sorted = [...deckCards].sort(byMissingDesc)
    // Meowscarada missing 2, Sprigatito missing 1, Floragato missing 0
    expect(sorted.map(c => c.card.name)).toEqual(['Meowscarada', 'Sprigatito', 'Floragato'])
  })

  it('breaks ties alphabetically', () => {
    const tied = [
      { card: { name: 'Zubat' }, expected_quantity: 2, scanned_quantity: 0 },
      { card: { name: 'Abra' }, expected_quantity: 2, scanned_quantity: 0 },
    ]
    const sorted = [...tied].sort(byMissingDesc)
    expect(sorted.map(c => c.card.name)).toEqual(['Abra', 'Zubat'])
  })
})

describe('byCardNumberAsc', () => {
  it('sorts numerically, not as strings (so "10" comes after "2")', () => {
    const sorted = [...deckCards].sort(byCardNumberAsc)
    expect(sorted.map(c => c.card.number)).toEqual(['1', '2', '10'])
  })

  it('handles a non-numeric prefix without crashing', () => {
    const withPrefix = [
      { card: { name: 'A', number: 'TG04' } },
      { card: { name: 'B', number: 'TG01' } },
    ]
    const sorted = [...withPrefix].sort(byCardNumberAsc)
    expect(sorted.map(c => c.card.number)).toEqual(['TG01', 'TG04'])
  })
})

describe('selectVisibleDeckCards', () => {
  it('defaults to missing-quantity-descending order', () => {
    const result = selectVisibleDeckCards(deckCards, 'all')
    expect(result.map(c => c.card.name)).toEqual(['Meowscarada', 'Sprigatito', 'Floragato'])
  })

  it('filters to only missing cards', () => {
    const result = selectVisibleDeckCards(deckCards, 'missing')
    expect(result.map(c => c.card.name)).toEqual(['Meowscarada', 'Sprigatito'])
  })

  it('filters to cards with at least one copy scanned (overlaps with missing)', () => {
    // Meowscarada is 1/3 scanned — appears here AND under 'missing'.
    const result = selectVisibleDeckCards(deckCards, 'found')
    expect(result.map(c => c.card.name)).toEqual(['Meowscarada', 'Floragato'])
  })

  it('accepts an explicit sort mode, applied the same way regardless of which tab is active', () => {
    const alphabetical = selectVisibleDeckCards(deckCards, 'all', 'alphabetical')
    expect(alphabetical.map(c => c.card.name)).toEqual(['Floragato', 'Meowscarada', 'Sprigatito'])

    const byNumber = selectVisibleDeckCards(deckCards, 'all', 'number_asc')
    expect(byNumber.map(c => c.card.number)).toEqual(['1', '2', '10'])
  })

  it('does not mutate the input array', () => {
    const original = [...deckCards]
    selectVisibleDeckCards(deckCards, 'all')
    expect(deckCards).toEqual(original)
  })
})
