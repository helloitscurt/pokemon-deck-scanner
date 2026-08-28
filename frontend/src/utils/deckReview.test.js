import { describe, expect, it } from 'vitest'
import { clampDeckEntryQuantity, countUnresolvedEntries, setEntryCard, setEntryQuantity } from './deckReview'

describe('clampDeckEntryQuantity', () => {
  it('clamps to the 1-99 range', () => {
    expect(clampDeckEntryQuantity(0)).toBe(1)
    expect(clampDeckEntryQuantity(-5)).toBe(1)
    expect(clampDeckEntryQuantity(150)).toBe(99)
    expect(clampDeckEntryQuantity(18)).toBe(18)
  })

  it('falls back to 1 for empty or non-numeric input, matching an emptied quantity field', () => {
    expect(clampDeckEntryQuantity('')).toBe(1)
    expect(clampDeckEntryQuantity(undefined)).toBe(1)
    expect(clampDeckEntryQuantity('not a number')).toBe(1)
  })
})

describe('countUnresolvedEntries', () => {
  it('counts only entries with no resolved card_id', () => {
    const entries = [
      { raw_name: 'Houndour', card_id: 'sv1-33_en' },
      { raw_name: 'Lucario ex', card_id: null },
      { raw_name: 'Armarouge ex', card_id: undefined },
    ]
    expect(countUnresolvedEntries(entries)).toBe(2)
  })

  it('is zero once every entry has a card_id', () => {
    const entries = [{ card_id: 'a' }, { card_id: 'b' }]
    expect(countUnresolvedEntries(entries)).toBe(0)
  })
})

describe('setEntryCard', () => {
  it('resolves the entry at the given index and marks it confident, leaving others untouched', () => {
    const entries = [
      { raw_name: 'Lucario ex', card_id: null, confident: false },
      { raw_name: 'Riolu', card_id: 'sv1-112_en', confident: true },
    ]
    const card = { id: 'svp-17_en', name: 'Lucario ex' }

    const result = setEntryCard(entries, 0, card)

    expect(result[0].card_id).toBe('svp-17_en')
    expect(result[0].card).toBe(card)
    expect(result[0].confident).toBe(true)
    expect(result[1]).toBe(entries[1]) // untouched entry keeps its identity
  })

  it('does not mutate the original array', () => {
    const entries = [{ raw_name: 'Lucario ex', card_id: null }]
    setEntryCard(entries, 0, { id: 'svp-17_en' })
    expect(entries[0].card_id).toBeNull()
  })
})

describe('setEntryQuantity', () => {
  it('updates and clamps the quantity at the given index only', () => {
    const entries = [
      { raw_name: 'Basic Fighting Energy', expected_quantity: 1 },
      { raw_name: 'Nest Ball', expected_quantity: 2 },
    ]

    const result = setEntryQuantity(entries, 0, '500')

    expect(result[0].expected_quantity).toBe(99)
    expect(result[1].expected_quantity).toBe(2)
  })
})
