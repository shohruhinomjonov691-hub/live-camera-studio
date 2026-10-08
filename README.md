# Face Blur

A small web app that detects faces in a photo, blurs them, and lets you download the result. Faces the detector misses can be covered by drawing a rectangle by hand.

> **Automatic detection does not guarantee that every face is found.** Always review the preview before downloading and add manual regions where needed. The UI shows this warning permanently (in Uzbek).

The detector is reused from the `cv_opencv.ipynb` notebook in [computer_vision](https://github.com/shohruhinomjonov691-hub/computer_vision): OpenCV's bundled frontal-face Haar cascade. No training, model download, face recognition, or paid API is involved. The original notebooks are not modified.

## Features

- JPEG/PNG upload → face detection → blurred preview → download.
- Detected face count and a bounding-box toggle.
- Manual rectangles drawn on the responsive preview (mouse or touch); coordinates are mapped to original image pixels.
- Remove any automatic or manual region before downloading.
- Output is re-encoded from raw pixels in the input format, so EXIF (including GPS), ICC and PNG text metadata are not carried over. EXIF orientation is applied first, so what you see is what is processed.

## Privacy

- Images are processed in memory only. They are not written to disk, a database, or logs.
- The API reads the raw request body instead of multipart `UploadFile`, because Starlette spools uploads larger than 1 MB to a temporary file.
- API responses are sent with `Cache-Control: no-store`; the page uses a strict Content-Security-Policy.
- The server's access log contains only method, path and status. Region coordinates travel in a request header, not in the URL.
- The browser keeps the selected file and result in memory (object URLs) until the page is closed or another file is chosen.

## Limits and validation

| Check | Limit |
| --- | --- |
| File size | 10 MB (checked from `Content-Length` and while streaming) |
| Real format | JPEG or PNG by magic bytes; must match what Pillow decodes |
| Pixel size | ≤ 25 megapixels and ≤ 8000 px on the longest side (checked from the header before decoding) |
| Regions per request | ≤ 100 |
| Region coordinates | `0 ≤ x, y ≤ 8000`, `1 ≤ w, h ≤ 8000`; NaN, infinity and oversized numbers are rejected with `400` |

Invalid input returns `400`, `413`, `415` or `422` with a JSON `detail` message.

## Run locally

Tested with Python 3.13. OpenCV is pinned to the 4.x line: OpenCV 5 no longer ships `cv2.CascadeClassifier`.

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --host 127.0.0.1 --port 8765
```

Open http://127.0.0.1:8765.

## API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `{"status": "ok"}` |
| `POST` | `/api/detect` | raw JPEG/PNG bytes | `{"width", "height", "count", "faces": [{"x","y","w","h"}]}` in original (orientation-corrected) pixels |
| `POST` | `/api/blur` | raw JPEG/PNG bytes; header `X-Regions: [{"x","y","w","h","source":"auto"\|"manual"}]` | blurred image, same format, no metadata |

Automatic regions are padded by 15% on each side; manual regions are blurred exactly as drawn.

## Tests

```bash
pytest -q
```

Upload-flow race regressions (stale detect/blur replies after choosing another file) run with Node's built-in test runner, no packages needed:

```bash
node --test tests/js/*.test.mjs
```

Unit and API tests cover invalid/corrupt files, size and pixel limits, EXIF orientation, alpha flattening, region parsing and clipping, blur confined to regions, metadata stripping (EXIF/GPS, PNG text), and that a >1 MB upload opens no file for writing (checked with a Python audit hook) and adds nothing to the temp or project directories.

These tests use synthetic images. **They do not measure face-detection quality.**

## Detection evaluation — not done yet

No real evaluation images have been provided, so precision/recall/count error have **not** been measured. The planned evaluation:

- 20–30 images with manually annotated face boxes, from your own, consented, or license-checked sources. Images are never committed (`eval/images/` is ignored).
- Metrics: face-level recall at IoU ≥ 0.5 (primary — a missed face is a privacy failure), precision, and per-image count error; small and profile/rotated faces reported separately.
- Compare 2–3 `scaleFactor`/`minNeighbors` settings in `app/config.py` and record the chosen one.

Known limitation until then: the Haar cascade is frontal-face only and is likely to miss small, rotated, profile or occluded faces.

## Project layout

```text
app/main.py        FastAPI app, body size limit, security headers
app/image_io.py    Format/size validation, decode with EXIF orientation, metadata-free encode
app/detector.py    Haar cascade detection on a downscaled grayscale copy
app/blur.py        Region parsing, padding/clipping, pixelate + Gaussian blur
app/static/        HTML/CSS/JS frontend
tests/             pytest suite
```

## Author

[Shokhrukhbek Inomjonov](https://github.com/shohruhinomjonov691-hub)
