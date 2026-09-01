// Lazy-loads the vendored Tesseract.js worker (frontend/public/tesseract/,
// see VENDORED.md) on first use and turns its raw OCR output into the two
// fields the deck-scoped match tier actually uses: a card's printed local/
// total collector number and its name — see matchDeckImage in
// frontend/src/api/client.js and POST /decks/instances/{id}/match-image in
// backend/api/decks.py. Deliberately narrow: those two fields are what
// identifies a specific printing, and both are short/high-contrast enough
// to be realistically OCR-able, unlike a card's other printed details.
// English only for now (see docs/plans/live-card-scanner.md's Phase 2).

import { createWorker } from 'tesseract.js'

let workerPromise = null

// Mirrors cardDetection.js's ensureReady() singleton-promise pattern: cache
// only the successful case, so a transient failure (network blip loading
// the ~4MB trained-data file) doesn't permanently wedge OCR for the rest of
// the page's lifetime with the same stale rejection.
function ensureWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: '/tesseract',
      // The vendored eng.traineddata is served as-is, not the .gz the
      // default CDN path would fetch — see VENDORED.md. cacheMethod is
      // left at its default (IndexedDB read+write) so the ~4MB file is
      // only ever fetched once per browser, not once per session.
      gzip: false,
    }).catch((err) => {
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

// Starts loading the OCR worker ahead of the first recognition call, same
// rationale as cardDetection.js's preloadCardDetection — except this one is
// intentionally NOT called until a card is actually detected (see "Two WASM
// libraries loaded per scan session, not one" in the plan): loading it
// alongside OpenCV.js upfront would double the initial-page-open payload
// for a feature that only pays off after detection succeeds anyway.
export function preloadCardOcr() {
  ensureWorker().catch(() => {})
}

// A Pokemon card's local/total collector number, e.g. "025/198" or, for
// special subsets, a short alpha prefix like "TG04/TG30" or "GG01/GG70".
const NUMBER_PATTERN = /\b([A-Za-z]{0,3}\d{1,4})\s*\/\s*([A-Za-z]{0,3}\d{1,4})\b/

// Tesseract commonly confuses these with digits inside a printed number
// (a genuine "052" misread as "O52") — checked empirically against
// backend/api/recognize.py's _normalize_collector_number, which does NOT
// tolerate this (see backend/tests/test_match_text.py). Real Pokemon
// local-number prefixes (TG, GG, SWSH, H, RC, SM) never use O/I/L, so this
// substitution has no legitimate downside, only fixes misreads.
function cleanNumberToken(token) {
  if (!token) return token
  return token.replace(/[OoIl]/g, (ch) => ({ O: '0', o: '0', I: '1', l: '1' }[ch]))
}

// Exported for its own direct test coverage (see cardOcr.test.js) — pure
// text-in, fields-out. Name is NOT extracted here (see pickCardName below)
// — a real-device card (a "Potion" Trainer card) proved a flat-text,
// first-plausible-line heuristic picks up mid-card noise ("- eee ollie")
// instead of the actual name, which only position + confidence data (not
// available from a flat string) can reliably tell apart.
export function parseCardOcrText(rawText) {
  const numberMatch = String(rawText || '').match(NUMBER_PATTERN)
  return {
    number_local: numberMatch ? cleanNumberToken(numberMatch[1]) : null,
    number_total: numberMatch ? cleanNumberToken(numberMatch[2]) : null,
  }
}

// Structural card-frame labels that sit in the same top band as the real
// name but are never it (checked against the actual layout of Pokemon,
// Trainer/Item, Supporter, Stadium, and Energy cards). Compared
// case-insensitively against a candidate line's full trimmed text, not a
// substring — "Potion" doesn't contain "item" as a whole word, but a line
// that IS just "Item" does.
const NAME_BAND_DENYLIST = new Set([
  'trainer', 'item', 'supporter', 'stadium', 'energy', 'basic', 'hp',
  'pokemon', 'pokémon', 'ex', 'gx', 'v', 'vmax', 'vstar',
])

// The name is always printed in a banner near the top of a card — position
// is a much stronger signal than "first line with letters" (see
// parseCardOcrText's comment for why that failed). Fraction of the card's
// height to search, and the minimum Tesseract confidence (0-100) to trust
// — both are reasoned starting points, not empirically calibrated against
// real cards yet; expect to retune after more real-device data.
const NAME_BAND_FRACTION = 0.22
const MIN_NAME_CONFIDENCE = 40

// Flattens Tesseract's blocks -> paragraphs -> lines -> words into one
// list. Each word carries its own text/confidence/bbox — see index.d.ts in
// the vendored tesseract.js package for the shape. Requires
// output: {blocks: true} on the recognize() call (off by default —
// text-only is Tesseract.js's own default output, for performance).
//
// Word-level, not line-level: a real-device card ("Potion") proved
// line-level grouping dilutes a single clean, correctly-recognized word
// sitting next to garbled OCR noise on the same line — the line's overall
// confidence (and merged text) reflected its worst neighbor, not the good
// word itself. Tesseract's own flat-text output contained "Potion"
// correctly; the line-grouped view didn't surface it as a usable
// candidate at all. Filtering per-word lets a good word survive bad
// neighbors, and adjacent surviving words get joined back into a name in
// their original reading order (top-to-bottom, then left-to-right).
export function flattenWords(blocks) {
  const words = []
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          words.push(word)
        }
      }
    }
  }
  return words
}

// Exported for its own direct test coverage (see cardOcr.test.js) —
// pure data-in, name-out. cardHeight is the OCR crop's pixel height (same
// coordinate space as each word's bbox); passing 0/undefined disables the
// position filter (used defensively, not expected in real use).
export function pickCardName(blocks, cardHeight) {
  const candidates = flattenWords(blocks).filter((word) => {
    const text = (word.text || '').trim()
    if (!/[A-Za-z]/.test(text)) return false
    if ((word.confidence ?? 0) < MIN_NAME_CONFIDENCE) return false
    if (NAME_BAND_DENYLIST.has(text.toLowerCase())) return false
    if (cardHeight && word.bbox) return word.bbox.y0 < cardHeight * NAME_BAND_FRACTION
    return true
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.bbox?.y0 ?? 0) - (b.bbox?.y0 ?? 0) || (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0))
  return candidates.map((word) => word.text.trim()).join(' ')
}

// Mutable, not React state — mirrors cardDetection.js's detectionStatus.
// DeckCardScanner reads this into its on-screen debug readout right after
// calling recognizeCardText, so "Tesseract found nothing at all" can be
// told apart from "Tesseract found text the parser above couldn't turn
// into a name/number" without server logs or devtools access on a phone.
export const lastOcrRawText = { value: '' }

// cardCanvas: the same cropped-card canvas cardDetection.js's extractCard()
// produces. Returns the parsed fields — never throws on a garbled/empty
// result, since "OCR found nothing usable" is an expected, common outcome
// this tier is explicitly built to fall back from (see the plan's Phase 2
// flow diagram), not an error.
// Same rationale as lastOcrRawText — the raw flat text alone can't show
// WHY pickCardName rejected everything: nothing recognized at all, or
// recognized-but-below-threshold/out-of-band candidates it correctly
// declined to guess from. DeckCardScanner surfaces this compactly (text,
// rounded confidence, y-position) so that distinction is visible without
// server logs — it directly decides whether NAME_BAND_FRACTION/
// MIN_NAME_CONFIDENCE need retuning or the problem is upstream of them.
// Word-level, matching what pickCardName itself now operates on.
export const lastOcrWords = { value: [] }

export async function recognizeCardText(cardCanvas) {
  const worker = await ensureWorker()
  // blocks: true is required for pickCardName's position/confidence data —
  // text: true keeps the flat string parseCardOcrText's number regex
  // already relies on.
  const { data } = await worker.recognize(cardCanvas, {}, { text: true, blocks: true })
  const rawText = data?.text || ''
  lastOcrRawText.value = rawText
  lastOcrWords.value = flattenWords(data?.blocks).map((w) => ({
    text: (w.text || '').trim(),
    confidence: Math.round(w.confidence ?? 0),
    y0: w.bbox?.y0 ?? null,
  }))
  return {
    ...parseCardOcrText(rawText),
    name: pickCardName(data?.blocks, cardCanvas?.height),
  }
}

let numberWorkerPromise = null

// A dedicated second worker for Phase 3's continuous throttled number-only
// pass (docs/plans/live-card-scanner.md, Decision 5) — deliberately NOT
// shared with ensureWorker()'s singleton above. Verified against
// tesseract.js's own source: setParameters/recognize are both jobs queued
// on one worker, processed serially, and setParameters persists across
// later jobs — a shared worker would leak this narrow whitelist into Path
// A's full-card capture-time OCR, and the two calls would queue behind
// each other instead of running concurrently. The ~4MB eng.traineddata
// itself is still fetched once and shared via the same IndexedDB cache
// ensureWorker() already relies on — only the worker instance is
// duplicated, not the language-data download.
function ensureNumberWorker() {
  if (!numberWorkerPromise) {
    numberWorkerPromise = createWorker('eng', 1, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: '/tesseract',
      gzip: false,
    }).then(async (worker) => {
      // Narrows the engine's search space to what a collector number can
      // ever contain (digits, a slash, and the occasional short alpha
      // prefix/suffix — see NUMBER_PATTERN). Set once here, not per call —
      // this worker is never used for anything else, so the whitelist
      // persisting across every future job on it is exactly what's wanted.
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
      })
      return worker
    }).catch((err) => {
      numberWorkerPromise = null
      throw err
    })
  }
  return numberWorkerPromise
}

// Starts loading the number-only worker ahead of Path B's first throttled
// tick (docs/plans/live-card-scanner.md, Phase 3) — unlike preloadCardOcr
// above, this one IS called upfront, alongside preloadCardDetection, not
// deferred until a card is detected. Path A's OCR worker can wait because
// it's only ever needed after a full stable-hold capture; Path B's badge
// is meant to update live "while still framing" the card, and its first
// tick fires ~700ms after hunting starts — sooner than a stable hold would
// even complete — so deferring this further would just make the session's
// very first reading lag even more visibly behind every one after it.
export function preloadNumberOcr() {
  ensureNumberWorker().catch(() => {})
}

// Pure confidence math, split out of recognizeNumberRegion below so it can
// be unit-tested directly (same reasoning as numberBand.js's own crop-rect
// extraction) without needing a mocked Tesseract worker. Per the plan's
// Decision 1: the average confidence of the words that make up the read
// number text itself, not a whole-crop average that could be diluted by
// stray noise elsewhere in the crop — falls back to Tesseract's own
// page-level confidence only when no words were recognized at all (a
// blank/garbled crop, where there's nothing number-shaped to average).
export function computeNumberReadConfidence(blocks, pageConfidence) {
  const words = flattenWords(blocks)
  const numberWords = words.filter((w) => /[0-9A-Za-z/]/.test(w.text || ''))
  if (!numberWords.length) return Math.round(pageConfidence ?? 0)
  const total = numberWords.reduce((sum, w) => sum + (w.confidence ?? 0), 0)
  return Math.round(total / numberWords.length)
}

// A second, narrower OCR call for Phase 3's throttled Path B pass — reads
// only a small crop already framed on the collector number (see
// numberBand.js), not a full card.
export async function recognizeNumberRegion(canvas) {
  const worker = await ensureNumberWorker()
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true })
  const rawText = data?.text || ''
  const { number_local, number_total } = parseCardOcrText(rawText)
  const confidence = computeNumberReadConfidence(data?.blocks, data?.confidence)
  return { number_local, number_total, confidence }
}
