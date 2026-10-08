# Vendored MediaPipe files

Downloaded 2026-10-08 (Asia/Seoul). Files are byte-for-byte copies of the sources below; nothing was edited.
Served from this app's own origin, so the page needs no CDN.

## `@mediapipe/tasks-vision` 1.0.1

- Source: `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.0.1.tgz`
- Published: 2026-07-31. Chosen over 1.1.0 (published 2026-10-06) because it had been stable for two months.
- Tarball integrity (matches the npm registry `dist.integrity`):
  `sha512-rvRE2FmAZ6ZxKSw7wq+e+jQDpN3t1B/tD2mJz9SmAzb1msoDkd4dMoE4wAh8Z30Um0PQwLiHr9QtomhmXk3aUQ==`
- Tarball SHA-256: `ee318eaa3d42230aa10910d114faf2a488c577c4e4d33c7cb04126924aca505f`
- License: Apache-2.0 (`package.json` `"license": "Apache-2.0"`). The tarball ships no license file, so
  `LICENSE` here is the Apache License 2.0 text from the MediaPipe repository (see below).

Only the files the app loads are kept (the ES-module WASM build, used from a module worker):

| File | SHA-256 |
| --- | --- |
| `tasks-vision-1.0.1/vision_bundle.mjs` | `d885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f` |
| `tasks-vision-1.0.1/wasm/vision_wasm_module_internal.js` | `da8934057f147b622e82cfb4c0dbd85461c598e268588b5a8ba9ca963a8ff82d` |
| `tasks-vision-1.0.1/wasm/vision_wasm_module_internal.wasm` | `2dabd8e23c60984628beb7bb338764c81a08e6837145273f59578684b5d53c1b` |

Not vendored: the classic and no-SIMD WASM builds, `vision_bundle.cjs`/`.js`, source maps and type definitions.
Browsers without WebAssembly SIMD therefore cannot run the live detector; the camera tab shows the error state.

## BlazeFace short-range face detector model

- File: `models/blaze_face_short_range.tflite`, 229,746 bytes
- SHA-256: `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`
- Source: `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`
  (identical to `.../float16/latest/...` on the download date)
- License: **Apache License, Version 2.0** — stated under "LICENSED UNDER" in the official model card
  "MediaPipe BlazeFace Model Card (Short Range)", dated June 9, 2021:
  `https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf`
  (model card PDF SHA-256 `cd335c06fc0de7807cd815a0777a697932598bcdb28fa98adaaabf847485f758`; linked from
  `https://developers.google.com/edge/mediapipe/solutions/vision/face_detector`).
- Model card limits relevant here: targets faces close to a front-facing camera; faces looking away, strongly
  tilted, or further than about 2 m are out of scope; surveillance and identity recognition are out of scope.

## Face Landmarker model bundle (glasses effect)

- File: `models/face_landmarker.task`, 3,758,596 bytes
- SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`
- Source: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
  (identical to `.../float16/latest/...` on 2026-10-08), linked from
  `https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker`.
- The bundle contains three models; each official model card states **"LICENSED UNDER Apache License, Version 2.0"**:
  - BlazeFace short range — "MediaPipe BlazeFace Model Card (Short Range)", June 9, 2021 (see above).
  - FaceMesh V2 — `https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf`,
    model date September 15, 2022 (PDF SHA-256 `c6add060f4ebfb37b2690136b6c711c7e5fcb7038baa2649ae3338b83979565a`).
  - Blendshape V2 — `https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf`
    (PDF SHA-256 `c8e9cf60a39998f4b341740623917590e050d1c97004e2de4568d84e026445ae`). Blendshapes are not used
    (`outputFaceBlendshapes: false`).
- Model card note: predicted landmarks do not provide facial recognition or identification.
- Loaded only when the user turns the glasses effect on.

## `LICENSE`

- Source: `https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE`
  (repository `master` at `f6988c4769278bde600efd488dfc8645432dc92b` on the download date)
- SHA-256: `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8`

## Not included

The Selfie Segmenter model (background effects) is planned for a later batch and is not vendored. Its license must
be confirmed from its model card before it is added.
