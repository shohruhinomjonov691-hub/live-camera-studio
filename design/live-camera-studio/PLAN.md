# Live Camera Studio — dizayn va texnik reja

- Sana: 2026-10-08 (Asia/Seoul). Rejim: BUILD (1-batch amalga oshirildi, `develop` branch). Bajaruvchi: Claude Code. Reviewer: Codex.
- Asos: `main` @ `ad4c1d5` “feat: Face Blur MVP” (kutilgan commit bilan mos edi).
- Manba: foydalanuvchi topshiriqlari (2026-10-08) va loyiha koordinatsiyasi uchun alohida (xususiy) task/handoff yozuvlari.
- 1-batch: kamera + jonli yuz blur, EN/KO, error code’lar, MediaPipe vendor — amalga oshirildi (natija pastda). Push va deploy qilinmadi.

## Foydalanuvchi qarorlari (2026-10-08)

| Mavzu | Qaror |
| --- | --- |
| Nomi | **Live Camera Studio** |
| Til | **English default + Korean** switcher. Matnlar alohida translation fayllarida; tanlov refresh’dan keyin saqlanadi |
| Yuz effekti | Faqat **ko‘zoynak** |
| Processing | Jonli kadrlar **brauzerda** ishlanadi |
| Kutubxona | **MediaPipe Tasks Vision**; rasmiy paket/WASM/model fayllari versiyasi qotirilgan holda lokal vendor qilinadi |
| Privacy qoidasi | Yuz blur yoqilganda detector tayyor bo‘lmasa, xato bersa yoki yuz topmasa — **butun kadr yashiriladi**. Bu “kafolatlangan anonimlashtirish” deb nomlanmaydi |
| Debug panel | Review boshqaruvlari production UI’ga kirmaydi |
| Implementation | Mavjud MVP va shu reja Codex review’dan o‘tmaguncha boshlanmaydi |

## Fayllar

| Fayl | Vazifa |
| --- | --- |
| `mockup.html` | Production ko‘rinishidagi maket: debug panelsiz, EN/KO switcher bilan |
| `i18n/en.js`, `i18n/ko.js` | Barcha UI matnlari (bir xil kalitlar). `file://`da ishlashi uchun JSON emas, `window.LCS_I18N` ga yozadigan JS |
| `review.html` | **Faqat dizayn review**: holat, til, blur, desktop/390 px tanlovi; maketni iframe’da ochadi. App’ga ko‘chirilmaydi |
| `screenshots/` | Generated; commit qilinmaydi (`.gitignore`) |

### Ochish

```bash
open design/live-camera-studio/review.html
```

Faqat maketning o‘zi: `open design/live-camera-studio/mockup.html`. Hash parametrlari: `state=idle|prompt|loading|live|noface|snapshot|denied|nocam|error`, `mode=privacy|effects|background`, `tab=camera|upload`, `bg=none|blur|image`, `upload=empty|detecting|editor|draw|error`, `blur=off`, `later=off`, `lang=en|ko` (hash’dagi til faqat ko‘rish uchun, saqlanmaydi).

**Preview soxta** — SVG illyustratsiya. Kadrda “Sample frame · not detection” belgisi va “Face · sample” yorlig‘i turadi; bu belgi ham faqat maketga tegishli.

## Dizayn

- To‘q tema; bitta accent `#8aa6ff`; ogohlantirish sariq, xato qizil, “yuz topildi” yashil.
- Kontrast: yordamchi matn `--faint #95a0b1` (surface ustida 6.6:1), ikkinchi darajali `--muted #b6bfcc` (9.4:1); yordamchi matnlar kamida 13 px. Koreyscha uchun `word-break: keep-all` va `Apple SD Gothic Neo` / `Noto Sans KR` fallback.
- Desktop: 16:9 preview + control bar, o‘ngda 368 px panel (Privacy / Effects / Background) va sessiya snapshotlari.
- Mobil (≤900 px): preview 4:5, `max-height: 64svh` — panel birinchi ekranda ko‘rinib turadi; boshqaruv preview ustida (kamera o‘chirish · 60 px shutter · old/orqa kamera, 44 px tegish maydoni); FPS chip va privacy pill yashiriladi.
- Qatlam tartibi: kamera → fon → ko‘zoynak → **yuz blur doim eng ustida**. Bbox snapshotga chizilmaydi.
- Mavjud ogohlantirish (“Automatic detection does not guarantee that every face is found”) ikkala bo‘limda doimiy.

### Holatlar

| Holat | Trigger (implementation) | UI |
| --- | --- | --- |
| Camera off | boshlang‘ich / foydalanuvchi o‘chirdi | “Turn on camera”, localhost/HTTPS eslatmasi |
| Permission | `getUserMedia` kutilmoqda | brauzer so‘roviga yo‘llovchi strelka |
| Loading | oqim va model tayyorlanmoqda | 3 qadamli progress; **kadr yashirin** |
| Live | ≥1 yuz | LIVE, yuzlar soni, FPS (“not measured” agar o‘lchanmagan) |
| No face, blur yoqilgan | 0 yuz | **butun kadr yashirin** (“Preview hidden”), HUD va boshqaruv ko‘rinadi, snapshot o‘chirilgan |
| No face, blur o‘chiq | 0 yuz | sariq banner, snapshot o‘chirilgan |
| Snapshot | shutter | flash + “Snapshot ready · Download” |
| Denied | `NotAllowedError` | 3 qadamli yo‘riqnoma, Try again, Photo upload |
| No camera / busy | `NotFoundError`, `NotReadableError` | Check again, Photo upload |
| Error | detector xatosi | **kadr yashirin**, snapshot to‘xtatilgan, Restart detector |

`window.isSecureContext` yolg‘on yoki `navigator.mediaDevices` yo‘q bo‘lsa — “Camera off” holatidagi localhost/HTTPS matni xato sifatida ko‘rsatiladi.

## Privacy pipeline — fail-closed (implementation talabi; Codex review P1 bo‘yicha qayta yozildi)

Yuz blur yoqilganda (privacy rejimi) **blur va detection aynan bitta captured frame’ga tegishli**. Xom `<video>` hech qachon ko‘rinmaydi (`display: none`; faqat manba sifatida).

1. **Capture.** Har tick’da `createImageBitmap(video)` bilan kadr `F` olinadi va unga `{camSession, frameId}` biriktiriladi. Bir vaqtda faqat bitta kadr ishlanmoqda bo‘ladi; navbatdagi kadr oldingisi tugaguncha olinmaydi (eski kadrlar to‘planmaydi).
2. **Detect.** `F` detector’ga beriladi (worker, pastda). Natija `R(F)` kelganda `camSession` va `frameId` joriy bo‘lmasa — tashlanadi, `F.close()`.
3. **Compose.** `R(F)` ≥1 yuz bo‘lsa: off-screen buffer’ga **aynan `F`** chiziladi, `R(F)` bbox’lari (25% padding — BlazeFace bbox’i Haar’nikidan tor) shu bufer ichida blur qilinadi; tayyor bufer ko‘rinadigan canvas’ga bir martada ko‘chiriladi. Yangi video kadrini eski bbox bilan chizish yo‘q — “hold” ham yo‘q.
4. **Pending.** Natija kutilayotganda ko‘rinadigan canvas oxirgi **to‘liq ishlangan** kadrda muzlaydi (ko‘rinadigan FPS = detection tezligi). Pending 1000 ms’dan oshsa — canvas tozalanadi va “Preview hidden” ko‘rsatiladi.
5. **0 yuz / xato / tayyor emas.** Ko‘rinadigan canvas va off-screen bufer darhol `clearRect` bilan tozalanadi (oldingi ishlangan kadr ham qolmaydi), “Preview hidden” overlay, snapshot o‘chiriladi. Faqat keyingi muvaffaqiyatli `R(F)` bilan qayta ko‘rinadi.
6. **Snapshot.** Faqat oxirgi compose qilingan bufer’dan (`F` + `R(F)` blur), u ≥1 yuzli, joriy `camSession`ga tegishli va pending timeout o‘tmagan bo‘lsa. Bbox alohida overlay canvas’da — snapshotga kirmaydi. Snapshot hech qachon xom `video`dan olinmaydi.
7. **Effektlar/fon (2–3-batch).** Landmarker/segmenter ham aynan `F` ustida ishlaydi; compose barcha natijalar kelgach bir marta. Yuz blur doim oxirgi qatlam.
8. **Yuz blur o‘chiq bo‘lsa** (foydalanuvchi tanlovi, faqat effekt rejimi): xom kadr chizilishi mumkin; HUD “Face blur off” deb ko‘rsatadi.

Matnlarda “reduces exposure, not guaranteed anonymization” saqlanadi. Ochiq savol “ushlab turish oynasi” yopildi: **hold yo‘q**.

## Kamera lifecycle

| Hodisa | Talab |
| --- | --- |
| Start | `const id = ++camSession`; holat `prompt`; `await getUserMedia(...)`. Qaytganda `id !== camSession` bo‘lsa — kelgan stream’ning barcha track’lari darhol `stop()`, natija ishlatilmaydi |
| Permission javobsiz qoladi | MDN bo‘yicha so‘rov hech qachon yakunlanmasligi mumkin: “prompt” holatida **Cancel** tugmasi (= Stop). Kech kelgan stream yuqoridagi qoida bo‘yicha yopiladi |
| Stop (tugma, tab “Photo upload”, `pagehide`) | `++camSession`; `cancelAnimationFrame` / `video.cancelVideoFrameCallback`; worker’dagi navbat bekor (natijalar session bilan tashlanadi); barcha track `stop()`; `video.srcObject = null`; ko‘rinadigan va off-screen canvas `clearRect`; ochiq `ImageBitmap`lar `close()`; holat `idle` |
| `visibilitychange` → hidden | Stop bilan bir xil (kamera bo‘shatiladi). Qaytganda avtomatik qayta yoqilmaydi — “Camera off”, bitta bosish bilan qayta yoqiladi |
| Kamera almashtirish (old/orqa, `deviceId`) | Avval to‘liq Stop, keyin yangi Start (yangi `camSession`) — ikki stream bir vaqtda ochiq bo‘lmaydi |
| `track.onended` / `mute` uzoq davom etsa | Stop + “No camera / busy” yoki “Error” holati |
| `devicechange` | Qurilmalar ro‘yxati yangilanadi; joriy track tirik bo‘lsa davom etadi |
| Worker xatosi / `onerror` | Error holati: canvas tozalanadi, snapshot o‘chadi, “Restart detector” |
| Snapshot blob’lari | Ro‘yxatdan o‘chirilganda va `pagehide`da `revokeObjectURL` |

Testlar (1-batch): fake `getUserMedia` (kechiktirilgan promise) bilan — Stop’dan keyin kelgan stream’ning track’lari to‘xtatilgani; eski `camSession` natijasi chizilmasligi; 0 yuz/xatoda canvas tozalangani; snapshot faqat ishlangan bufer’dan olingani.

## MediaPipe ishlash byudjeti

- **Worker birinchi tanlov:** detection dedicated module worker’da (`worker-src 'self'`), kadr `ImageBitmap` sifatida transfer qilinadi. MediaPipe’ning worker ichida, production CSP ostida (bundle + WASM + model, `'wasm-unsafe-eval'`) ishlashi 1-batchning **birinchi qadami (spike)** sifatida tekshiriladi — hali tasdiqlanmagan.
- **Fallback — main thread, o‘lchangan byudjet bilan:** detection kirishi 320 px gacha kichraytiriladi; `detectForVideo` p95 ≤ 16 ms bo‘lishi va 50 ms’dan uzun task bo‘lmasligi kerak (`performance.now` + `PerformanceObserver('longtask')`). Byudjet buzilsa detection tezligi pasaytiriladi; ko‘rinadigan kadr baribir faqat ishlangan kadr (fail-closed o‘zgarmaydi).
- Qayd etiladi: qurilma/brauzer, worker yoki main thread, p50/p95 latency, ko‘rinadigan FPS. O‘lchanmagan bo‘lsa README’da ochiq yoziladi.

## Reuse va dependency

| Ehtiyoj | Mavjud kod | Reja |
| --- | --- | --- |
| Jonli yuz bbox | `app/detector.py` (Haar, server) — brauzerda ishlamaydi | MediaPipe **Face Detector** |
| Yuz blur | `app/blur.py::_obscure` (pixelate + Gauss), `AUTO_PADDING` 15% | Algoritm Canvas 2D’da qayta yoziladi; jonli rejimda padding 25% |
| Ko‘zoynak | Yo‘q | MediaPipe **Face Landmarker** |
| Fon | Yo‘q | MediaPipe **Image Segmenter** (selfie segmenter) |
| Snapshot | `encode_image` metadata’siz | `canvas.toBlob("image/png")`, serverga yuborilmaydi |
| Upload / manual blur | `app.js`, `/api/detect`, `/api/blur` | Mantiq o‘zgarmaydi; matnlar EN/KO translation fayllariga ko‘chadi |

### Vendor qilinadigan fayllar (rejalashtirilgan; hali yuklab olinmagan)

2026-10-08 da npm registry va Google Cloud Storage’dan tekshirildi:

| Artefakt | Manba | Versiya | Litsenziya | Hajm |
| --- | --- | --- | --- | --- |
| `@mediapipe/tasks-vision` (JS bundle + `wasm/`) | `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.0.1.tgz` | **1.0.1** (2026-07-31). Integrity `sha512-rvRE2FmAZ6ZxKSw7wq+e+jQDpN3t1B/tD2mJz9SmAzb1msoDkd4dMoE4wAh8Z30Um0PQwLiHr9QtomhmXk3aUQ==` | Apache-2.0 (npm metadata) | paket ~36.8 MB unpacked; faqat kerakli bundle + `wasm/` olinadi |
| `blaze_face_short_range.tflite` | `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/` | `float16/1` | model card’da tekshiriladi (kutilgan: Apache-2.0) | 229 746 B |
| `face_landmarker.task` (2-batch) | `…/face_landmarker/face_landmarker/float16/1/` | `float16/1` | model card’da tekshiriladi | 3 758 596 B |
| `selfie_segmenter.tflite` (3-batch) | `…/image_segmenter/selfie_segmenter/float16/1/` | `float16/1` | model card’da tekshiriladi | 249 537 B |

- `1.1.0` (2026-10-06) eng yangi, lekin 2 kunlik — supply-chain ehtiyoti uchun 2 oydan beri barqaror `1.0.1` tanlandi.
- Joylashuv: `app/static/vendor/mediapipe/tasks-vision-1.0.1/` va `app/static/vendor/mediapipe/models/`; yoniga `SOURCES.md` (URL, versiya, sha256, litsenziya, yuklab olingan sana) va `LICENSE`.
- Har batchda faqat o‘sha batchga kerak model yuklanadi.

### Xavfsizlik headerlari va CSP (1-batch)

- CSP: `script-src 'self' 'wasm-unsafe-eval'`; `worker-src 'self'` (blob kerak bo‘lsa spike natijasi bilan asoslanadi). `style-src 'self'` o‘zgarmaydi; CDN yo‘q.
- **Maket kodi production’ga bevosita ko‘chirilmaydi:** `mockup.html`dagi inline `<script>`, `<style>` va `style="..."` atributlari hozirgi CSP’da bloklanadi. Production’da: tashqi `.css`/`.js` fayllar, pozitsiyalar JS’dan CSSOM (`el.style.left = ...`) orqali, fon swatch’lari CSS klasslar bilan. Tarjimadagi `<b>`/`<strong>` uchun `innerHTML` ishlatilmaydi — matn qismlarga bo‘linadi yoki DOM tugunlari bilan quriladi.
- `Permissions-Policy: camera=(self)`.
- Kadr uchun `fetch`/XHR yo‘q (network kuzatuvi bilan tekshiriladi).

### Backend xatolari — barqaror error code (1-batch)

Hozir `ImageError(status, message)` o‘zbekcha matn qaytaradi. Reja:

- `ImageError(status, code, message)`; javob `{"code": "...", "detail": "..."}`. `detail` faqat log/debug uchun inglizcha; UI hech qachon `detail`ni ko‘rsatmaydi.
- Kodlar: `empty_file` (400), `unsupported_format` (415), `file_too_large` (413), `image_too_large` (413 — megapiksel/tomon), `corrupt_image` (422), `invalid_regions` (400 — JSON, tur, chegara, jumladan katta koordinatalar), `too_many_regions` (400).
- Client: `t("error." + code)`; noma’lum kod → `error.unknown` (HTTP status bilan); tarmoq xatosi → `error.network`. Kalitlar `i18n/en.js` va `ko.js`da allaqachon bor.
- Testlar har bir xato yo‘li uchun `code`ni tekshiradi; mavjud status testlari saqlanadi.

## Implementation batchlari

Commitlar `fix:` prefiksi bilan. Boshlanish sharti: Face Blur MVP va shu reja Codex review’dan o‘tgan.

0. **Review tuzatishlari (bajarildi, `cec7488`, `ff51908`).** Upload async poygasi: har tanlangan fayl yangi `session` ochadi; detect/blur natijalari session va `blurSeq` bilan tekshiriladi, eski javoblar tashlanadi, yangi fayl tanlanganda eski preview/natija darhol tozalanadi. `X-Regions` koordinatalari `0 ≤ x,y ≤ 8000`, `1 ≤ w,h ≤ 8000`, NaN/inf/juda katta butun son → 400 (avval 500). Regression testlar: `tests/js/upload_race.test.mjs` (`node --test`), `tests/test_blur.py`, `tests/test_api.py`.
1. **Kamera + jonli yuz blur.** (a) Spike: MediaPipe worker + CSP. (b) Vendor `tasks-vision` 1.0.1 + BlazeFace (`SOURCES.md`). (c) i18n infratuzilmasi (`app/static/i18n/`), mavjud upload UI va backend error code’lari EN/KO. (d) To‘q tema, tablar. (e) `camera.js`: lifecycle jadvali, fail-closed pipeline. (f) CSP/`Permissions-Policy` testlari. (g) Mavjud testlar + yangi lifecycle/pipeline testlari; desktop/mobil brauzer tekshiruvi; byudjet o‘lchovi; README.
2. **Ko‘zoynak + snapshot.** Face Landmarker aynan `F` ustida; ko‘z nuqtalari bo‘yicha joylash/burish; kompozit snapshot PNG, sessiya ro‘yxati.
3. **Fon blur / fon rasmi.** Image Segmenter aynan `F` ustida; 4 ichki fon + foydalanuvchi rasmi (faqat brauzer xotirasida); chegara sifati va byudjet ta’siri o‘lchanadi.

## 1-batch natijasi (2026-10-08, `develop`)

- **Spike muvaffaqiyatli:** MediaPipe Face Detector module worker’da, production CSP (`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`) ostida ishladi; CSP buzilishi yo‘q. Bundle module worker’da `importScripts` o‘rniga `import()` ishlatadi, shuning uchun `forVisionTasks(path, true)` bilan `wasm_module` varianti vendor qilindi. Main-thread fallback kerak bo‘lmadi va qo‘shilmadi.
- Vendor: `app/static/vendor/mediapipe/` (`SOURCES.md`: manba, versiya, SHA-256, litsenziya). Model litsenziyasi model card’dan tasdiqlandi (Apache 2.0). Landmarker/segmenter qo‘shilmadi.
- Pipeline: bitta `ImageBitmap` olinadi, nusxasi worker’ga transfer qilinadi, blur aynan shu kadrga; `requestVideoFrameCallback` (bo‘lmasa `requestAnimationFrame`) — faqat yangi video kadrda; pending 1000 ms; 0 yuz/xato/timeout’da canvas tozalanadi; xom `<video>` ko‘rinmaydi.
- Lifecycle: `camSession`, kech stream yopiladi, Cancel, Stop/`visibilitychange`/`pagehide`/tab almashuvi/`track.ended`, kamera almashtirish = Stop + Start, worker xatosi → error.
- Backend: `{"code", "detail"}`; UI kodni EN/KO’ga tarjima qiladi.
- O‘lchov (Apple M2, headless Chrome 154, fake kamera = test portreti, real webcam emas): 30 FPS (manba 30 fps), detector p95 8.7 ms, latency p95 9.0 ms.
- Snapshot, ko‘zoynak, fon — bu batchga kirmadi.

## 2-batch natijasi (2026-10-08, `develop`)

- **Vendor:** `face_landmarker.task` (`float16/1`, SHA-256 `64184e22…`); bundle ichidagi uchala model (BlazeFace, FaceMesh V2, Blendshape V2) model card’lari — Apache 2.0. `SOURCES.md` va hash testi.
- **Worker:** landmarker faqat ko‘zoynak yoqilganda yuklanadi; detector bilan aynan bitta bitmap’da. MediaPipe har task’dan keyin `self.ModuleFactory`ni tozalaydi, module worker’da loader qayta bajarilmaydi — shuning uchun worker loader’ning default export’ini import qilib, har task oldidan qayta o‘rnatadi (brauzerda tekshirilgan).
- **Qatlamlar:** kadr → ko‘zoynak (ko‘z burchaklari 33/133/362/263, bosh egilishi bo‘yicha burilish) → yuz blur (oxirgi). Landmarker yuklanmasa yoki xato bersa faqat effekt o‘chadi; ko‘zoynak chizishdagi xato ham blur’ni o‘chirmaydi.
- **Snapshot:** ko‘rinayotgan ishlangan canvas’dan (xom video emas), Mirror yoqilgan bo‘lsa preview kabi aylantiriladi; bbox/HUD yo‘q; PNG chunk’lari faqat `IHDR/IDAT/IEND`. Tugma faqat `live` holatida yoqiq (loading, blur qayta yoqilgandan keyingi pending, hidden, error, stopped — o‘chiq). Kadrlar orasidagi qisqa kutishda ekranda oxirgi ishlangan kadr turadi va u snapshot qilinadi.
- **O‘lchov (fake kamera, Apple M2, headless Chrome 154):** ko‘zoynak bilan 30 FPS, latency p95 20.6 ms; ko‘zoynaksiz p95 ~9 ms.

## Ochiq savollar

- Koreyscha tarjima — Claude qoralamasi, ona tilida so‘zlashuvchi tekshiruvi kerak.
- Real webcam va telefonlarda tekshiruv (FPS, mobil portret kadr, orqa kamera) — hali bajarilmagan.
- Model litsenziyalari model card’dan tasdiqlanishi kerak; `1.0.1` registry ma’lumotini reviewer mustaqil qayta tasdiqlamagan (tarmoq xatosi).
- Pending timeout (1000 ms) qiymati o‘lchov asosida aniqlanadi.
- Face detection evaluation rasmlari hali berilmagan.
