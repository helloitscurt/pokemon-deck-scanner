import { describe, expect, it } from 'vitest'
import { computeNumberReadConfidence, parseCardOcrText, pickCardName } from './cardOcr'

describe('parseCardOcrText', () => {
  it('extracts number from a clean recognition', () => {
    const result = parseCardOcrText('Pikachu\nHP 60\nThunder Shock\n025/198')
    expect(result.number_local).toBe('025')
    expect(result.number_total).toBe('198')
  })

  it('never extracts a name — position/confidence data only pickCardName has', () => {
    // A real Trainer card ("Potion") proved a flat-text, first-plausible-
    // line heuristic picks up mid-card noise instead of the real name (see
    // pickCardName's tests for the actual fix). This function no longer
    // even tries.
    expect(parseCardOcrText('Pikachu\nHP 60\n025/198').name).toBeUndefined()
  })

  it('tolerates stray whitespace and inconsistent spacing around the number', () => {
    const result = parseCardOcrText('Pikachu\n\n  025  /  198  \n')
    expect(result.number_local).toBe('025')
    expect(result.number_total).toBe('198')
  })

  it('preserves a short alpha prefix on special-subset numbers', () => {
    const result = parseCardOcrText('Gholdengo ex\nTG04/TG30')
    expect(result.number_local).toBe('TG04')
    expect(result.number_total).toBe('TG30')
  })

  it('corrects letter-O/digit-zero confusion within a number token', () => {
    // A real "052" misread as "O52" — see backend/api/recognize.py's
    // _normalize_collector_number, which does NOT tolerate this itself.
    // Fixed here, at the OCR-specific source of the ambiguity, since
    // normalize_scanner_card_number (used by the deck-scoped number match
    // in backend/api/decks.py) shares the same underlying normalizer.
    const result = parseCardOcrText('Pikachu\nO52/l98')
    expect(result.number_local).toBe('052')
    expect(result.number_total).toBe('198')
  })

  it('returns null fields instead of guessing when nothing usable was recognized', () => {
    const result = parseCardOcrText('~~~ ][ .. \n1 2 3')
    expect(result.number_local).toBeNull()
    expect(result.number_total).toBeNull()
  })

  it('handles empty or missing input without throwing', () => {
    expect(parseCardOcrText('')).toMatchObject({ number_local: null })
    expect(parseCardOcrText(null)).toMatchObject({ number_local: null })
  })
})

// Minimal Tesseract-shaped line — see index.d.ts in the vendored
// tesseract.js-core package for the real Block/Paragraph/Line/Word shape.
// pickCardName reads text/confidence/bbox at the WORD level (see its own
// comment for why: line-level grouping diluted a good word's confidence
// with its garbled neighbors on a real device). One word per fixture line
// keeps each test's intent readable; blocksOf nests them all under a
// single line, which flattenWords doesn't care about.
function ocrWord(text, confidence, y0, x0 = 0) {
  return { text, confidence, bbox: { x0, y0, x1: x0 + text.length * 10, y1: y0 + 20 } }
}

function blocksOf(...words) {
  return [{ paragraphs: [{ lines: [{ words }] }] }]
}

describe('pickCardName', () => {
  const CARD_HEIGHT = 1050 // matches OCR_CROP_HEIGHT in DeckCardScanner.jsx

  it('picks the real name word over mid-card noise — the actual Potion-card regression', () => {
    // Reconstructs the real-device failure: the old flat-text heuristic
    // picked up "- eee ollie" (mid-card OCR noise) as the name instead of
    // the actual top-banner word. Position + confidence should prefer the
    // top-band, higher-confidence word instead.
    const blocks = blocksOf(
      ocrWord('Item', 55, 40),
      ocrWord('Potion', 88, 90),
      ocrWord('eee', 62, 500),
      ocrWord('ollie', 60, 500, 40),
      ocrWord('Heal', 71, 650),
    )
    expect(pickCardName(blocks, CARD_HEIGHT)).toBe('Potion')
  })

  it('joins multiple surviving words into a multi-word name, in reading order', () => {
    // The point of word-level (not line-level) filtering: a name like
    // "Professor's Research" is two separate OCR words that both need to
    // individually clear the bar and then get reassembled in order.
    const blocks = blocksOf(
      ocrWord('Research', 85, 90, 120), // deliberately listed out of order
      ocrWord("Professor's", 82, 90, 0),
    )
    expect(pickCardName(blocks, CARD_HEIGHT)).toBe("Professor's Research")
  })

  it('ignores structural card-frame labels even at high confidence in the name band', () => {
    const blocks = blocksOf(
      ocrWord('TRAINER', 95, 30),
      ocrWord('Item', 92, 50),
      ocrWord('Potion', 80, 90),
    )
    expect(pickCardName(blocks, CARD_HEIGHT)).toBe('Potion')
  })

  it('ignores low-confidence words even if positioned correctly', () => {
    const blocks = blocksOf(ocrWord('gibberish', 15, 60))
    expect(pickCardName(blocks, CARD_HEIGHT)).toBeNull()
  })

  it('ignores a high-confidence word outside the top name band', () => {
    const blocks = blocksOf(ocrWord('Somewhere', 90, 900))
    expect(pickCardName(blocks, CARD_HEIGHT)).toBeNull()
  })

  it('drops a low-confidence neighbor but keeps the good word next to it', () => {
    const blocks = blocksOf(
      ocrWord('Pxtion', 20, 90, 0), // a garbled second read, low confidence
      ocrWord('Potion', 91, 90, 60),
    )
    expect(pickCardName(blocks, CARD_HEIGHT)).toBe('Potion')
  })

  it('returns null for empty or missing blocks', () => {
    expect(pickCardName([], CARD_HEIGHT)).toBeNull()
    expect(pickCardName(null, CARD_HEIGHT)).toBeNull()
    expect(pickCardName(undefined, CARD_HEIGHT)).toBeNull()
  })

  it('disables the position filter when cardHeight is not provided, confidence/denylist still apply', () => {
    const blocks = blocksOf(ocrWord('Potion', 88, 900))
    expect(pickCardName(blocks, 0)).toBe('Potion')
  })
})

describe('computeNumberReadConfidence', () => {
  it('averages the confidence of the number-shaped words, not a whole-page figure', () => {
    const blocks = blocksOf(ocrWord('025/198', 90, 50), ocrWord('025/198', 70, 50, 80))
    // (90 + 70) / 2 = 80 — the page-level figure (10) must be ignored
    // entirely once real words were found.
    expect(computeNumberReadConfidence(blocks, 10)).toBe(80)
  })

  it('falls back to the page-level confidence when no words were recognized at all', () => {
    expect(computeNumberReadConfidence([], 42)).toBe(42)
    expect(computeNumberReadConfidence(null, 42)).toBe(42)
  })

  it('rounds the averaged confidence', () => {
    const blocks = blocksOf(ocrWord('025/198', 91, 50), ocrWord('025/198', 90, 50, 80))
    expect(computeNumberReadConfidence(blocks, 0)).toBe(91) // (91+90)/2 = 90.5 -> 91
  })

  it('counts a word with no confidence value as 0, not excluding it from the average', () => {
    const blocks = [{
      paragraphs: [{ lines: [{ words: [
        { text: '025/198', confidence: 100, bbox: { x0: 0, y0: 50, x1: 70, y1: 70 } },
        { text: '/', confidence: undefined, bbox: { x0: 80, y0: 50, x1: 90, y1: 70 } },
      ] }] }],
    }]
    // (100 + 0) / 2 = 50 — excluding the undefined-confidence word instead
    // would give 100.
    expect(computeNumberReadConfidence(blocks, 0)).toBe(50)
  })
})
