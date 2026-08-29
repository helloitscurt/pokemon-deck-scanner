# Vendored third-party OCR assets

Loaded lazily by `frontend/src/utils/cardOcr.js`, only after a card is
detected in the live scanner (see "Two WASM libraries loaded per scan
session, not one" under Phase 2 Risks in
`docs/plans/live-card-scanner.md`) — never part of the main app bundle, and
never on the same critical path as `frontend/public/opencv/`'s detection
library. Same rationale as that directory: no third-party CDN dependency for
a self-hosted app (Tesseract.js's own defaults pull `workerPath`/`corePath`/
`langPath` from `cdn.jsdelivr.net`, which this app's CSP does not allow and
which a self-hosted app shouldn't depend on anyway).

`tesseract.js` itself (the `createWorker` API surface) is a normal npm
dependency, bundled by Vite like any other import — unlike jscanify, its
package.json correctly maps a browser-safe entry via `"browser"`, so no raw
`<script>` vendoring is needed for it. Only the pieces it fetches at
*runtime* are vendored here.

English only for now — see the plan's Phase 2 for why (OCR accuracy is
unvalidated per-language, and each additional language is several more MB).

## worker.min.js

- Source: `tesseract.js` npm package, version 7.0.0, `dist/worker.min.js`
- License: Apache License 2.0 — see `worker.min.js.LICENSE.txt`

## tesseract-core-simd-lstm.wasm.js

- Source: `tesseract.js-core` npm package, version 6.1.2,
  `tesseract-core-simd-lstm.wasm.js`
- The LSTM-only, SIMD-accelerated build — deliberately not the larger
  `tesseract-core-simd.wasm.js` (bundles the legacy engine too, which this
  app never uses: `createWorker` is called with `OEM.LSTM_ONLY`) or the
  split `.js` + `.wasm` pair (Tesseract.js's own `getCore.js` only picks
  those apart via feature-detection when `corePath` is a *directory*;
  pointing `corePath` at this exact file bypasses that entirely, so only one
  file needs vendoring, not a feature-detected set of four).
- License: Apache License 2.0 — see `tesseract-core-simd-lstm.wasm.js.LICENSE.txt`

## eng.traineddata

- Source: `https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata`
- The "fast" (integer-quantized) tier, not `tessdata` (23.5MB, full-precision)
  or `tessdata_best` (15.4MB, highest-accuracy) — collector numbers are
  short, high-contrast printed digits (see "The verified backend seam" in
  the plan), not the kind of text this size/accuracy tradeoff should hurt;
  worth revisiting if real-device testing shows otherwise.
- Served uncompressed: `cardOcr.js` passes `gzip: false` to `createWorker`,
  since this file (unlike the CDN's own `.traineddata.gz`) isn't gzipped.
- Fetched: 2026-08-29
- License: Apache License 2.0 (https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE)
