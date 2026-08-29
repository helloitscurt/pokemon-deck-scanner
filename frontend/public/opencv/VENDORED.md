# Vendored third-party scripts

Loaded lazily (dynamic `<script>` injection) by
`frontend/src/utils/cardDetection.js` only when the live card scanner opens —
never part of the main app bundle. See
`docs/plans/live-card-scanner.md` ("OpenCV.js bundle size" under Phase 1
Risks) for why these are vendored here instead of pulled from a CDN at
runtime: no third-party runtime dependency for a self-hosted app, and no
single point of failure if a CDN is unreachable.

## opencv.js

- Source: `https://docs.opencv.org/4.9.0/opencv.js` (official OpenCV.js build)
- Version: 4.9.0
- Fetched: 2026-08-29
- License: Apache License 2.0 (https://github.com/opencv/opencv/blob/4.9.0/LICENSE)

## jscanify.js

- Source: `https://github.com/puffinsoft/jscanify/blob/954863b80e8407bbd2a659fcba6583ce3176a419/src/jscanify.js`
  (the browser build — this package's npm entry point defaults to a
  Node.js build with `canvas`/`jsdom` dependencies we don't need and that
  don't compile in a minimal container; the browser build has none of that)
- Version: 1.4.0 (per the file's own header comment), commit
  `954863b80e8407bbd2a659fcba6583ce3176a419` on `master`
- Fetched: 2026-08-29
- License: MIT (c) ColonelParrot and other contributors — see `LICENSE-jscanify.txt`
  in this directory
