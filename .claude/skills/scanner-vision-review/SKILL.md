---
name: scanner-vision-review
description: Domain-lens review for the live card scanner — camera capture lifecycle, OCR/vision-provider recognition, confidence thresholds, and provider rate-limiting. Use standalone for a scanner-only diff, or fold into multi-persona-review (tag M) when a plan/diff touches DeckCardScanner.jsx, scan_providers.py, scan_queue.py, or gemini_rate_limit.py.
---

Review scanner-touching changes against the specific failure modes this pipeline has actually
hit, not generic OCR advice. Tag findings `M-N` in severity order (HIGH/MED/LOW) — this tag is
shared with `multi-persona-review` so the two compose into one findings table when both run
against the same plan/diff.

Scope: [`frontend/src/components/DeckCardScanner.jsx`](../../../frontend/src/components/DeckCardScanner.jsx)
(camera capture, stability tracking, OCR), [`backend/services/scan_providers.py`](../../../backend/services/scan_providers.py)
(Gemini / OpenAI-compatible vision providers), [`backend/services/scan_queue.py`](../../../backend/services/scan_queue.py),
[`backend/services/gemini_rate_limit.py`](../../../backend/services/gemini_rate_limit.py), and
`backend/services/card_metadata.py`'s confidence fallback. Out of scope: pure visual styling of
the scanner UI (that's `ui-review`'s job) and non-scanner OCR-adjacent code.

Ask:

- **Confidence thresholds guard the SPECIFIC failure mode they claim to.** A threshold or preset
  ("Careful" mode, a minimum-confidence cutoff) is only correct if verified against the actual
  shape of low-confidence OCR/vision output it's meant to catch — not assumed from the variable
  name. (This has been wrong before: a Tesseract confidence score didn't protect against the
  failure mode a "Careful" preset was supposed to guard against.)
- **Provider separation stays intact.** Gemini is the default with its own retry/rate-limit path
  left untouched; the second, OpenAI-compatible provider reads its base URL from environment only
  — never from user/request input, which would be a server-side request forgery. Does new code
  preserve that split, or add a path where a request could influence which host gets called?
- **New call sites route through the existing limiter.** `gemini_rate_limit.py` implements
  cross-worker pacing (rate/burst/penalty, interactive-request priority) and a persisted
  daily-quota penalty. A new Gemini call site that bypasses this — a direct API call, a retry loop
  that doesn't respect the shared limiter — can burn quota or trigger the repeat-penalty path for
  every user, not just the one triggering it.
- **Camera/device lifecycle survives remount, not just mount.** `DeckCardScanner.jsx` coordinates
  a live `getUserMedia` stream through several refs (stream, canvases, abort controller, stability
  tracker) and effects gated on `phase`/`cameraStatus`. A prior real bug was the stream not
  reattaching when the video element remounted. On any change to these refs/effects, check: does
  the stream get released exactly once (not leaked, not double-released) across mount, remount,
  and unmount — including React StrictMode's double-invoke in dev and HMR?
- **Preprocessing changes invalidate tuned thresholds silently.** If capture resolution,
  compression, or cropping changes, any confidence/stability threshold tuned against the old
  output is now unverified — flag it as needing re-validation, don't assume it still holds.
- **Both providers are handled the same way on failure.** A malformed, empty, or rate-limited
  response needs the same fallback behavior whether it came from Gemini or the OpenAI-compatible
  path — check new recognition code against both, not just the provider it was written/tested
  against.

**When to flag vs. stay quiet:** flag any change to a confidence/threshold value, a new call site
into a vision provider, any change to `scan_providers.py`'s base-URL handling, and any
ref/effect touching the live camera stream. Stay quiet on scanner UI copy, layout, or styling
changes with no logic/provider/camera-lifecycle component — that's `ui-review`'s lens, not this
one.
