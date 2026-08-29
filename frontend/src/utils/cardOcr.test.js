import { describe, expect, it } from 'vitest'
import { parseCardOcrText, pickCardName } from './cardOcr'

describe('parseCardOcrText', () => {
  it('extracts number and HP from a clean recognition', () => {
    const result = parseCardOcrText('Pikachu\nHP 60\nThunder Shock\n025/198')
    expect(result.number_local).toBe('025')
    expect(result.number_total).toBe('198')
    expect(result.hp).toBe('60')
    expect(result.language).toBe('en')
  })

  it('never extracts a name — position/confidence data only pickCardName has', () => {
    // A real Trainer card ("Potion") proved a flat-text, first-plausible-
    // line heuristic picks up mid-card noise instead of the real name (see
    // pickCardName's tests for the actual fix). This function no longer
    // even tries.
    expect(parseCardOcrText('Pikachu\nHP 60\n025/198').name).toBeNull()
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

// Minimal Tesseract-shaped line — see index.d.ts in the vendored
// tesseract.js-core package for the real Block/Paragraph/Line/Word shape.
// pickCardName only reads text/confidence/bbox.y0, so nothing else is
// needed here.
function line(text, confidence, y0) {
  return { text, confidence, bbox: { x0: 0, y0, x1: 100, y1: y0 + 20 } }
}

function blocksOf(...lines) {
  return [{ paragraphs: [{ lines }] }]
}

describe('pickCardName', () => {
  const CARD_HEIGHT = 1050 // matches OCR_CROP_HEIGHT in DeckCardScanner.jsx

  it('picks the real name over mid-card noise — the actual Potion-card regression', () => {
    // Reconstructs the real-device failure: the old flat-text heuristic
    // picked up "- eee ollie" (mid-card OCR noise) as the name instead of
    // the actual top-banner text. Position + confidence should prefer the
    // top-band, higher-confidence line instead.
    const blocks = blocksOf(
      line('Item', 55, 40),
      line('Potion', 88, 90),
      line('- eee ollie', 62, 500),
      line('Heal 30 damage from | of your Pokemon.', 71, 650),
    )
    expect(pickCardName(blocks, CARD_HEIGHT)).toBe('Potion')
  })

  it('ignores structural card-frame labels even at high confidence in the name band', () => {
    const blocks = blocksOf(
      line('TRAINER', 95, 30),
      line('Item', 92, 50),
      line('Potion', 80, 90),
    )
    expect(pickCardName(blocks, CARD_HEIGHT)).toBe('Potion')
  })

  it('ignores low-confidence lines even if positioned correctly', () => {
    const blocks = blocksOf(line('gibberish', 15, 60))
    expect(pickCardName(blocks, CARD_HEIGHT)).toBeNull()
  })

  it('ignores a high-confidence line outside the top name band', () => {
    const blocks = blocksOf(line('Somewhere down here', 90, 900))
    expect(pickCardName(blocks, CARD_HEIGHT)).toBeNull()
  })

  it('picks the highest-confidence candidate when several are in the name band', () => {
    const blocks = blocksOf(
      line('Potjon', 55, 85), // a garbled second OCR guess at the same text
      line('Potion', 91, 90),
    )
    expect(pickCardName(blocks, CARD_HEIGHT)).toBe('Potion')
  })

  it('returns null for empty or missing blocks', () => {
    expect(pickCardName([], CARD_HEIGHT)).toBeNull()
    expect(pickCardName(null, CARD_HEIGHT)).toBeNull()
    expect(pickCardName(undefined, CARD_HEIGHT)).toBeNull()
  })

  it('disables the position filter when cardHeight is not provided, confidence/denylist still apply', () => {
    const blocks = blocksOf(line('Potion', 88, 900))
    expect(pickCardName(blocks, 0)).toBe('Potion')
  })
})
