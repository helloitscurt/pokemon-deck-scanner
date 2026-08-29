// Lazy-loads the vendored Tesseract.js worker (frontend/public/tesseract/,
// see VENDORED.md) on first use and turns its raw OCR text into the
// structured fields backend/api/recognize.py's POST /cards/match-text
// expects — see "The verified backend seam" in
// docs/plans/live-card-scanner.md's Phase 2. English only for now (see the
// plan for why); language is hardcoded to match the one model loaded below.

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
const HP_PATTERN = /\bHP\s*(\d{2,3})\b|\b(\d{2,3})\s*HP\b/i

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
// text-in, fields-out, no worker/canvas involved, per the plan's own
// testing note: "real logic with real bug potential, separate from whether
// the backend correctly matches once it has clean fields."
export function parseCardOcrText(rawText) {
  const text = String(rawText || '')
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)

  const numberMatch = text.match(NUMBER_PATTERN)
  const hpMatch = text.match(HP_PATTERN)

  // No reliable pattern for a card's decorative, stylized name — best
  // effort: the first line with enough letters to plausibly be a name, not
  // a stray symbol/number line OCR sometimes emits first. Deliberately
  // conservative elsewhere (set_code, artist, regulation_mark, card_type
  // are left for a future pass, not guessed at here) — a wrong-but-present
  // value actively contradicts the correct candidate in the backend's
  // matcher, which is worse than leaving a field null (neutral).
  const name = lines.find((line) => /[A-Za-z]{3,}/.test(line) && !/^HP\b/i.test(line)) || null

  return {
    name,
    name_en: null,
    number_local: numberMatch ? cleanNumberToken(numberMatch[1]) : null,
    number_total: numberMatch ? cleanNumberToken(numberMatch[2]) : null,
    set_code: null,
    hp: hpMatch ? (hpMatch[1] || hpMatch[2]) : null,
    language: 'en',
  }
}

// cardCanvas: the same cropped-card canvas cardDetection.js's extractCard()
// produces. Returns the parsed fields — never throws on a garbled/empty
// result, since "OCR found nothing usable" is an expected, common outcome
// this tier is explicitly built to fall back from (see the plan's Phase 2
// flow diagram), not an error.
// Mutable, not React state — mirrors cardDetection.js's detectionStatus.
// DeckCardScanner reads this into its on-screen debug readout right after
// calling recognizeCardText, so "Tesseract found nothing at all" can be
// told apart from "Tesseract found text the parser above couldn't turn
// into a name/number" without server logs or devtools access on a phone.
export const lastOcrRawText = { value: '' }

export async function recognizeCardText(cardCanvas) {
  const worker = await ensureWorker()
  const { data } = await worker.recognize(cardCanvas)
  const rawText = data?.text || ''
  lastOcrRawText.value = rawText
  return parseCardOcrText(rawText)
}
