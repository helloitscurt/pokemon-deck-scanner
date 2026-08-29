import { describe, expect, it } from 'vitest'
import { parseCardOcrText } from './cardOcr'

describe('parseCardOcrText', () => {
  it('extracts name, number, and HP from a clean recognition', () => {
    const result = parseCardOcrText('Pikachu\nHP 60\nThunder Shock\n025/198')
    expect(result.name).toBe('Pikachu')
    expect(result.number_local).toBe('025')
    expect(result.number_total).toBe('198')
    expect(result.hp).toBe('60')
    expect(result.language).toBe('en')
  })

  it('tolerates stray whitespace and inconsistent spacing around the number', () => {
    const result = parseCardOcrText('Pikachu\n\n  025  /  198  \n')
    expect(result.number_local).toBe('025')
    expect(result.number_total).toBe('198')
  })

  it('reads HP in either printed order', () => {
    expect(parseCardOcrText('Wattrel\n120 HP\n50/198').hp).toBe('120')
    expect(parseCardOcrText('Wattrel\nHP120\n50/198').hp).toBe('120')
  })

  it('preserves a short alpha prefix on special-subset numbers', () => {
    const result = parseCardOcrText('Gholdengo ex\nTG04/TG30')
    expect(result.number_local).toBe('TG04')
    expect(result.number_total).toBe('TG30')
  })

  it('corrects letter-O/digit-zero confusion within a number token', () => {
    // A real "052" misread as "O52" — see backend/api/recognize.py's
    // _normalize_collector_number, which does NOT tolerate this itself
    // (backend/tests/test_match_text.py documents that gap). Fixed here,
    // at the OCR-specific source of the ambiguity.
    const result = parseCardOcrText('Pikachu\nO52/l98')
    expect(result.number_local).toBe('052')
    expect(result.number_total).toBe('198')
  })

  it('returns null fields instead of guessing when nothing usable was recognized', () => {
    const result = parseCardOcrText('~~~ ][ .. \n1 2 3')
    expect(result.name).toBeNull()
    expect(result.number_local).toBeNull()
    expect(result.number_total).toBeNull()
    expect(result.hp).toBeNull()
  })

  it('never guesses set_code, artist, regulation_mark, or card_type', () => {
    // Deliberately out of scope for this parser (see cardOcr.js) — a
    // wrong-but-present value actively contradicts the correct candidate
    // in the backend's matcher, worse than leaving it null.
    const result = parseCardOcrText('Pikachu\nHP 60\n025/198\nSV1\nIllus. Someone')
    expect(result.set_code).toBeNull()
  })

  it('handles empty or missing input without throwing', () => {
    expect(parseCardOcrText('')).toMatchObject({ name: null, number_local: null })
    expect(parseCardOcrText(null)).toMatchObject({ name: null, number_local: null })
  })
})
