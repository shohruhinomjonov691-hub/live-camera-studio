# Live Camera Studio

A small web app that blurs faces — live from the camera, or in an uploaded photo. Live frames are processed entirely in the browser; uploaded photos are processed in server memory and never stored.

> **Automatic detection does not guarantee that every face is found.** Review the preview before you download anything, and add manual regions to uploaded photos where needed. The UI shows this warning permanently.

The UI is in English by default, with a Korean language switcher; the choice is remembered in the browser.

## Features

**Live camera** (in the browser)

- Camera on/off, mirror, front/back switch (shown when the device has more than one camera).
- Real-time face blur: pixelate + Gaussian, Gaussian, or a solid block, in three strengths; optional face boxes on the preview.
- Fail-closed privacy mode: while face blur is on, the whole preview is hidden when the detector is loading, has failed, is slower than 1 s, or finds no face (see [Privacy](#privacy)). Hiding reduces exposure; it is **not** guaranteed anonymization.
- Clear states for permission prompt, blocked permission, no/busy camera, camera unplugged, insecure page and detector errors.
- Glasses effect: drawn on the eye landmarks of each frame (follows head tilt), adjustable size. Glasses and face blur are exclusive: turning glasses on turns face blur off (the UI then says faces are visible); turning blur on turns glasses off; opening Privacy turns face blur on and glasses off (the preview is wiped at once and reopens with the next blurred frame); turning glasses off yourself does not turn blur back on. If the effect fails, glasses turn off and blur turns back on.
- Snapshots: a PNG of the processed preview exactly as shown (blur, glasses, mirror), without face boxes or HUD and without metadata; kept in the tab until removed or the page closes. Available only while a processed frame is on screen.
- Background: Off, Blur (three strengths) or Image — one at a time; Image is available only after an image is chosen. The person is cut out by a selfie segmentation model on the same frame; layers are background → person → glasses or face blur. A background never changes the blur/glasses choice.
- Background image: JPEG, PNG or WebP, up to 10 MB, 25 megapixels and 8000 px per side; decoded in the browser (kept at most 1920 px), never uploaded. It is drawn the right way round for the mirrored preview and mirrored snapshots.

**Photo upload** (the original Face Blur flow)

- JPEG/PNG upload → face detection → blurred preview → download.
- Detected face count and a bounding-box toggle; manual rectangles drawn on the responsive preview (mouse or touch), mapped to original image pixels; remove any region before downloading.
- Output is re-encoded from raw pixels in the input format, so EXIF (including GPS), ICC and PNG text metadata are not carried over. EXIF orientation is applied first.

## Detectors

| Flow | Detector | Where it runs |
| --- | --- | --- |
| Live camera | MediaPipe Face Detector (BlazeFace short range), `@mediapipe/tasks-vision` 1.0.1 | Browser, in a module Web Worker |
| Glasses effect | MediaPipe Face Landmarker (loaded only when the effect is turned on) | Same worker, same frame as the detector |
| Background | MediaPipe Image Segmenter, selfie model (loaded only when a background is turned on) | Same worker, same frame |
| Photo upload | OpenCV frontal-face Haar cascade (reused from `cv_opencv.ipynb` in [computer_vision](https://github.com/shohruhinomjonov691-hub/computer_vision)) | Server, in memory |

MediaPipe files are vendored under `app/static/vendor/mediapipe/` (no CDN). Sources, exact versions, SHA-256 hashes and licenses (Apache-2.0 for the package and every model, per the official model cards) are recorded in [`SOURCES.md`](app/static/vendor/mediapipe/SOURCES.md). The model card puts faces looking away, strongly tilted, or further than about 2 m out of scope. No face recognition, training or paid API is involved.

## Privacy

Live camera:

- Camera frames never leave the browser: the camera code makes no network requests, and frames go only to a same-origin worker as transferred `ImageBitmap`s.
- The raw `<video>` is never shown. Each frame is captured once; the detector gets a copy and the blur is applied to that same frame with that frame's boxes — the preview never mixes old boxes with a newer frame.
- While a result is pending, the preview keeps the last processed frame; after 1 s, on zero faces (with blur on) or on any error, the canvas is cleared.
- Every camera start is a session. A stream granted after Cancel, and detector results that arrive after Stop, are discarded (tracks stopped, bitmaps closed). Stop, hiding the page, closing it, switching to Photo upload and a camera that ends all stop the tracks and the render loop and clear the canvas.
- Turning face blur off is a deliberate user choice: the live preview then shows faces unblurred, and the UI says so. Turning it back on clears the canvas at once; only a frame captured and processed with blur on reappears.
- Glasses use landmarks computed on the same captured frame as the face boxes. Changing blur or glasses drops the frame in flight, so a result from the old mode never reaches the screen. If the landmarker fails to load or errors, or drawing the glasses fails, the app fails closed: glasses turn off and face blur turns back on (the frame being drawn is blurred; otherwise the canvas is wiped at once).
- With a background on, a frame is shown only with a valid person mask of that same frame. While the segmenter loads, after it fails, or when a mask is missing or malformed, the preview is hidden (with a message and Retry) — the real background never reappears unannounced. Turning the background off recovers. Changing any background setting drops the frame in flight and keeps the preview covered (and snapshots blocked) until a frame processed with the new settings arrives. The background image is released on Remove and when the page closes.
- Snapshots copy the visible processed canvas (never the raw video), flipped like the preview when Mirror is on. They are disabled while loading, pending after blur is re-enabled, hidden, in error or stopped. `canvas.toBlob("image/png")` writes only image data (verified: `IHDR`, `IDAT`, `IEND` chunks). Snapshots are not uploaded.

Photo upload:

- Images are processed in memory only. They are not written to disk, a database, or logs.
- The API reads the raw request body instead of multipart `UploadFile`, because Starlette spools uploads larger than 1 MB to a temporary file.
- The server's access log contains only method, path and status. Region coordinates travel in a request header, not in the URL.
- The browser keeps the selected file and result in memory (object URLs) until the page is closed or another file is chosen. Replies for a previously chosen file are discarded.

Headers: `Content-Security-Policy` allows only same-origin scripts, styles, workers and connections, plus `'wasm-unsafe-eval'` so the vendored WebAssembly can compile (it does not allow JavaScript `eval`); no inline scripts or styles. `Permissions-Policy: camera=(self), microphone=(), geolocation=()`. API responses use `Cache-Control: no-store`.

## Limits and validation (upload)

| Check | Limit |
| --- | --- |
| File size | 10 MB (checked from `Content-Length` and while streaming) |
| Real format | JPEG or PNG by magic bytes; must match what Pillow decodes |
| Pixel size | ≤ 25 megapixels and ≤ 8000 px on the longest side (checked from the header before decoding) |
| Regions per request | ≤ 100 |
| Region coordinates | `0 ≤ x, y ≤ 8000`, `1 ≤ w, h ≤ 8000`; NaN, infinity and oversized numbers are rejected with `400` |

Errors return `400`, `413`, `415` or `422` with `{"code": "...", "detail": "..."}`. The UI translates the stable `code` (`empty_file`, `unsupported_format`, `file_too_large`, `image_too_large`, `corrupt_image`, `invalid_regions`, `too_many_regions`); `detail` is English and only for debugging.

## Run locally

Tested with Python 3.13. OpenCV is pinned to the 4.x line: OpenCV 5 no longer ships `cv2.CascadeClassifier`.

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --host 127.0.0.1 --port 8765
```

Open http://127.0.0.1:8765. The camera works only on `localhost` or HTTPS. The live detector needs a browser with module workers and WebAssembly SIMD. Only Chrome has been tested so far; Safari before 18 has no canvas filters, so its blur falls back to pixelation only.

## Docker

```bash
docker compose up -d --build --wait
```

The image (`python:3.13.16-slim-bookworm`, pinned by digest) contains the app and the vendored MediaPipe files and models; nothing is fetched at runtime. It runs as an unprivileged user with a read-only root filesystem, no capabilities, `no-new-privileges` and a `/health` healthcheck. `compose.yaml` is its own Compose project and publishes the app only on `127.0.0.1:${LCS_PORT:-18765}`.

## Deploying behind an existing Nginx

The camera needs HTTPS, so the app runs behind the host's existing Nginx (1.24.0; no second proxy) at `camera.gotrips.cloud`. Step-by-step instructions — DNS, HTTP bootstrap, certificate in certbot webroot mode, final HTTPS site, verification and rollback — are in [`deploy/nginx/README.md`](deploy/nginx/README.md). Only a new site, a new snippet and a new certificate are added; other sites are not modified.

On Nginx 1.24, HTTP/2 is the `http2` parameter of `listen` (`http2 on;` needs 1.25.1) and applies to every site on the same address:port; the deploy guide says how to check this before enabling it.

Uploaded photos must not be written to disk anywhere, including the proxy. `deploy/nginx/live-camera-studio-proxy.conf` streams request bodies to the app (`proxy_request_buffering off`), keeps any held body in memory (`client_body_buffer_size` ≥ the 10 MB limit), and streams responses without temp files (`proxy_buffering off`, `proxy_max_temp_file_size 0`). It does not override the app's security headers.

Local checks (Docker):

- `deploy/nginx/check-config.sh` — `nginx -t` with Nginx 1.24.0 for the bootstrap and final site files.
- `deploy/smoke/check.sh` — the app image behind Nginx 1.24.0 with that snippet, over HTTP/1.1 and over HTTPS + HTTP/2. `/api/detect` and `/api/blur` must return 200 with a valid body (JSON of the right shape; a fully decodable JPEG of the right size) for a ~3.5 MB upload, and Nginx must report no temp-file buffering. A control route with default-style buffering must report temp files, and the validators must reject a 404, swapped bodies and a truncated image — so the check can detect both kinds of regression. It also checks that the app container is read-only, non-root, healthy and has no filesystem changes.

## API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `{"status": "ok"}` |
| `POST` | `/api/detect` | raw JPEG/PNG bytes | `{"width", "height", "count", "faces": [{"x","y","w","h"}]}` in original (orientation-corrected) pixels |
| `POST` | `/api/blur` | raw JPEG/PNG bytes; header `X-Regions: [{"x","y","w","h","source":"auto"\|"manual"}]` | blurred image, same format, no metadata |

Automatic upload regions are padded by 15% on each side; manual regions are blurred exactly as drawn. Live-camera boxes are padded by 25%, because BlazeFace boxes are tighter than Haar boxes.

## Tests

```bash
pytest -q
node --test tests/js/*.test.mjs
```

- Python: invalid/corrupt files, size and pixel limits, EXIF orientation, alpha flattening, region parsing and bounds, error codes, security headers (CSP, `Permissions-Policy`, worker CSP, no inline script/style), vendored files served, blur confined to regions, metadata stripping, and that a >1 MB upload opens no file for writing and adds nothing to the temp or project directories.
- JavaScript (Node's built-in runner, no packages): upload races (stale detect/blur replies), the live camera controller with a fake camera/worker/timers (same-frame blur, cleared canvas on zero faces/timeout/error, late stream after Cancel, late result after Stop, `track.ended`, hidden page, permission errors, no network use, glasses layer order and failures, snapshot source/mirror/disabled states, bitmap cleanup, messages from a replaced worker), the detector worker with fake MediaPipe tasks (detector and landmarker created one at a time), the snapshot/pagehide flow of the page shell, and EN/KO coverage plus the saved language choice.

These tests use synthetic images and fakes. **They do not measure face-detection quality.** `tests/test_deploy.py` guards the deployment files statically; `deploy/smoke/check.sh` is the behavioural check.

### Live camera measurements

Measured 2026-10-08 on a MacBook Air (Apple M2, 8 cores, macOS 26.6.2), headless Chrome 154, MediaPipe running on the CPU (XNNPACK) in a Web Worker, 1280×720 frames. The "camera" was Chrome's fake capture device fed with MediaPipe's own test portrait (a still photo), **not a real webcam**:

| Metric | Result |
| --- | --- |
| Processed frames per second | 30 (= the fake camera's 30 fps; one detection per new video frame) |
| Detector time per frame | p50 7.4 ms, p95 8.7 ms |
| Capture → displayed latency | p50 7.6 ms, p95 9.0 ms |
| Detector start (worker, WASM, model) | about 0.1 s after the files are cached |
| With glasses on (detector + landmarker per frame) | 30 FPS; capture → displayed p95 20.6 ms |
| Background blur (detector + segmenter per frame) | 30 FPS; capture → displayed p95 17.8 ms |
| Background image | 28 FPS; capture → displayed p95 17.8 ms |

The fake camera shows a still photo, so these numbers say nothing about segmentation quality on real video (hair, hands, motion, several people).

The user ran real-webcam smoke tests on their Mac (reported as successful; no numbers recorded). Phones, Safari and Firefox have **not** been tested yet.

## Detection evaluation — not done yet

No real evaluation images have been provided, so precision/recall/count error have **not** been measured for either detector. The planned evaluation:

- 20–30 images with manually annotated face boxes, from your own, consented, or license-checked sources. Images are never committed (`eval/images/` is ignored).
- Metrics: face-level recall at IoU ≥ 0.5 (primary — a missed face is a privacy failure), precision, and per-image count error; small and profile/rotated faces reported separately.
- Compare 2–3 `scaleFactor`/`minNeighbors` settings in `app/config.py` and record the chosen one.

Known limitations until then: the Haar cascade is frontal-face only; BlazeFace short range targets faces within about 2 m of a front-facing camera. Both are likely to miss small, rotated, profile or occluded faces.

## Project layout

```text
app/main.py                   FastAPI app, body size limit, security headers
app/image_io.py               Format/size validation, decode with EXIF orientation, metadata-free encode
app/detector.py               Haar cascade detection on a downscaled grayscale copy (upload)
app/blur.py                   Region parsing, padding/clipping, pixelate + Gaussian blur (upload)
app/static/index.html         Page (no inline script or style)
app/static/shell.js           Tabs, language switcher, live camera UI
app/static/camera.js          Live camera controller: lifecycle, fail-closed frame pipeline, canvas blur
app/static/detector-worker.mjs  MediaPipe Face Detector in a module worker
app/static/app.js             Photo upload flow
app/static/i18n.js, i18n/     EN/KO strings and the saved language choice
app/static/vendor/mediapipe/  Vendored MediaPipe package files, model, LICENSE, SOURCES.md
design/live-camera-studio/    Design mockup and technical plan
Dockerfile, compose.yaml      Production image and its own Compose project (loopback port only)
deploy/nginx/                 Proxy snippet and example site for an existing Nginx
deploy/smoke/                 Local check: app behind Nginx, no image bytes on the proxy's disk
tests/                        pytest suite; tests/js/ Node tests
```

## License

The project code is licensed under the [MIT License](LICENSE). Files under `app/static/vendor/mediapipe/` (the MediaPipe Tasks Vision package and the BlazeFace, Face Landmarker and Selfie Segmenter models) keep their Apache License 2.0; see [`NOTICE`](NOTICE) and that folder's `LICENSE` and `SOURCES.md`.

## Author

[Shokhrukhbek Inomjonov](https://github.com/shohruhinomjonov691-hub)
