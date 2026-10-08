# Live Camera Studio — design and technical plan

This document records the design decisions behind the live camera features: what the app guarantees, what it
deliberately does not, and how it was verified. The user-facing summary is in the top-level `README.md`.

## Decisions

| Topic | Decision |
| --- | --- |
| Name | Live Camera Studio (the photo-upload flow keeps the original Face Blur behaviour) |
| UI language | English by default, Korean switcher; strings live in separate translation files; the choice is saved in the browser |
| Live processing | In the browser only. Camera frames never reach the server |
| Library | MediaPipe Tasks Vision, vendored with pinned versions (no CDN) |
| Face effect | Glasses only |
| Background | Off, blur, or a user-chosen image — one at a time |
| Privacy rule | While face blur is on, the whole frame is hidden whenever the detector is loading, has failed, is too slow or finds no face. This is described as reducing exposure, never as guaranteed anonymization |

## Files in this folder

| File | Purpose |
| --- | --- |
| `mockup.html` | Static design mockup (dark theme, desktop/mobile, EN/KO). Its preview is an SVG illustration, not detection |
| `i18n/en.js`, `i18n/ko.js` | Mockup strings |
| `review.html` | Design-review helper that switches mockup states in an iframe. Not part of the app |

```bash
open design/live-camera-studio/review.html
```

Mockup hash parameters: `state=idle|prompt|loading|live|noface|snapshot|denied|nocam|error`,
`mode=privacy|effects|background`, `tab=camera|upload`, `bg=none|blur|image`,
`upload=empty|detecting|editor|draw|error`, `blur=off`, `later=off`, `lang=en|ko`.

The mockup uses inline scripts and styles; it is not copied into the app, whose CSP forbids them.

## Visual design

- Dark theme, one accent colour (`#8aa6ff`); warnings amber, errors red, "face found" green.
- Contrast: helper text `#95a0b1` (6.6:1 on the surface colour), secondary text `#b6bfcc` (9.4:1); helper text is
  at least 13 px. Korean uses `word-break: keep-all` with Apple SD Gothic Neo / Noto Sans KR fallbacks.
- Desktop: 16:9 preview with a control bar, a 368 px settings panel (Privacy / Effects / Background) and session
  snapshots.
- Mobile (≤ 900 px): 4:5 preview capped at 64svh so the panel starts on the first screen; controls float over the
  preview (camera off, 60 px shutter, front/back camera; 44 px touch targets).
- The warning "Automatic detection does not guarantee that every face is found" is always visible in both sections.

### Camera states

| State | Trigger | UI |
| --- | --- | --- |
| Camera off | initial, or the user stopped it | "Turn on camera", note that the camera needs localhost or HTTPS |
| Permission | `getUserMedia` pending | Pointer to the browser prompt, Cancel |
| Loading | stream and model starting | Progress; the frame is hidden |
| Live | a processed frame is on screen | LIVE, face count, FPS and latency |
| Hidden | no face with blur on, timeout, background not ready or failed, settings just changed | "Preview hidden" with the reason; HUD and controls stay usable; snapshots disabled |
| Denied | `NotAllowedError` | How to allow the camera, Try again, Photo upload |
| No camera / busy | `NotFoundError`, `NotReadableError` | Check again, Photo upload |
| Ended | `track.ended` | Camera stopped message |
| Error | detector failure | Frame hidden, Restart detector |

## Fail-closed frame pipeline

1. **Capture.** One `ImageBitmap` `F` is taken from the (never displayed) `<video>` per new video frame
   (`requestVideoFrameCallback`, falling back to `requestAnimationFrame`). Only one frame is in the pipeline at a
   time; it carries the camera session and a frame id.
2. **Detect.** A copy of `F` is transferred to a module worker, which runs face detection — and, only when the
   matching feature is on, face landmarks and selfie segmentation — on that same bitmap.
3. **Accept.** A result is used only if its session and frame id match the frame in the pipeline. Anything else
   (late results, results after Stop, results from a replaced worker) is ignored.
4. **Compose.** On an off-screen buffer: background (blurred frame or the chosen image) → the person cut out by the
   mask of `F` → glasses → face blur, which is always the last layer. The finished buffer is copied to the visible
   canvas once. A new video frame is never drawn with older boxes, landmarks or masks.
5. **Pending.** While a result is pending, the screen keeps the last fully processed frame. After 1000 ms, if face
   blur or a background is on, the canvases are cleared and the preview is hidden; the late result is ignored and
   the next frame recovers.
6. **Hide.** With face blur on and no face, on any detector or render error, or with a background on but no valid
   mask for this frame, every canvas is cleared and nothing of the frame is shown.
7. **Settings changes.** Turning blur on, toggling glasses, or changing any background setting drops the frame in
   flight; turning blur on or changing the background also wipes the canvases at once, so only a frame processed
   with the new settings reappears.
8. **Snapshots** copy the visible processed canvas (never the raw video), flipped like the preview when Mirror is
   on, without boxes or HUD, encoded with `canvas.toBlob("image/png")` (only `IHDR`/`IDAT`/`IEND` chunks). They are
   disabled unless a processed frame is on screen.

### Glasses and face blur

- Glasses and face blur are exclusive: glasses on turns blur off (the UI then says faces are visible); turning blur
  on, or opening Privacy, turns blur on and glasses off; turning glasses off yourself does not re-enable blur.
- If the landmarker fails to load, returns an error, or drawing fails, the effect fails closed: glasses off, blur on,
  and a message stays visible until dismissed or retried.

### Background

- The mask is used only if it was requested for that frame and is complete with the frame's aspect ratio (±3%).
  While the segmenter loads, after a load or runtime error, or with an invalid mask, the preview stays hidden with
  a message and Retry (which recreates the segmenter). Turning the background off also recovers.
- Background images (JPEG, PNG, WebP; ≤ 10 MB; ≤ 25 MP and ≤ 8000 px per side) are decoded in the browser, kept at
  most 1920 px, never uploaded, and released on Remove and when the page closes. A newer choice discards an older
  decode still in progress.
- The image is drawn flipped when the preview is mirrored, so the preview and a mirrored snapshot show it the right
  way round.

## Camera lifecycle

| Event | Behaviour |
| --- | --- |
| Start | New session; a stream that arrives after Stop/Cancel is stopped at once |
| Permission never answered | Cancel stops waiting |
| Stop, Photo upload tab, `pagehide`, page hidden | Cancel the frame callback, drop the frame in flight (bitmaps closed), stop all tracks, `srcObject = null`, clear canvases |
| Camera switch | Full Stop, then Start |
| `track.ended` | Stop and show "camera stopped" |
| Worker error | Error state, canvases cleared; Restart detector creates a new worker; messages from the old worker are ignored |
| Snapshot URLs | Revoked on remove and `pagehide`; a snapshot still being encoded at `pagehide` is discarded |

## Worker and performance

- All MediaPipe tasks are created one at a time: each creation consumes and clears `self.ModuleFactory`, and in a
  module worker the cached loader module does not run again, so the worker restores the factory before each task.
- Detection runs on the CPU (XNNPACK) in a module worker, so the UI thread is not blocked. No main-thread fallback
  was needed.
- Measured with Chrome's fake camera fed with a still photo (Apple M2, headless Chrome 154, 1280×720, 30 fps
  source): detection only p95 ~9 ms end to end; with glasses p95 ~21 ms; with background blur or image p95 ~18 ms;
  30 FPS (28 with an image). These numbers say nothing about detection or segmentation quality.

## Security headers

- `Content-Security-Policy`: same-origin scripts, styles, workers and connections, plus `'wasm-unsafe-eval'` for the
  vendored WebAssembly; no inline scripts or styles; no CDN.
- `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
- The camera code makes no network requests.

## Backend errors

`ImageError(status, code, message)` returns `{"code", "detail"}`. Codes: `empty_file`, `unsupported_format`,
`file_too_large`, `image_too_large`, `corrupt_image`, `invalid_regions`, `too_many_regions`. The UI translates the
code; `detail` is English and only for debugging.

## Vendored files

Sources, exact versions, SHA-256 hashes and licenses are recorded in `app/static/vendor/mediapipe/SOURCES.md` and
checked by a test. `@mediapipe/tasks-vision` 1.0.1 (chosen over the then two-day-old 1.1.0) and the BlazeFace, Face
Landmarker and Selfie Segmenter models are Apache-2.0 per the package metadata and the official model cards.

## Limitations and open items

- **No quality evaluation yet.** Face detection (Haar for uploads, BlazeFace live), landmarks and segmentation have
  not been measured on annotated images; there are no precision/recall numbers. Planned: 20–30 consented or
  license-checked images with annotated faces; recall at IoU ≥ 0.5 as the primary metric.
- Real-camera checks so far are informal smoke tests on one Mac. Phones, Safari and Firefox are untested.
- Korean strings are a draft and need a native-speaker review.
- Live face boxes are padded by 25% (a heuristic for BlazeFace boxes, not yet validated on real faces).
- Segmentation edges (hair, hands), motion and several people at different distances are known weak spots of the
  selfie model.
