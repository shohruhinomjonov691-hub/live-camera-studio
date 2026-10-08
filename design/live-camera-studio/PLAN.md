# Live Camera Studio — dizayn va texnik reja

- Sana: 2026-10-08 (Asia/Seoul). Rejim: PLAN (dizayn yakunlandi). Bajaruvchi: Claude Code. Reviewer: Codex.
- Asos: `main` @ `ad4c1d5` “feat: Face Blur MVP” (kutilgan commit bilan mos edi).
- Manba: foydalanuvchi topshiriqlari (2026-10-08), HQ [task](../../../../Engineering-HQ/tasks/2026-10-08-live-camera-studio.md) va [yakuniy tanlovlar handoff](../../../../Engineering-HQ/handoffs/2026-10-08-yakuniy-tanlovlar.md).
- Bu bosqichda install, vendor yuklab olish, kamera implementation, push va deploy qilinmadi. App kodi (`app/`) o‘zgartirilmadi.

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

Faqat maketning o‘zi: `open design/live-camera-studio/mockup.html`. Hash parametrlari: `state=idle|prompt|loading|live|noface|snapshot|denied|nocam|error`, `mode=privacy|effects|background`, `tab=camera|upload`, `bg=none|blur|image`, `blur=off`, `later=off`, `lang=en|ko` (hash’dagi til faqat ko‘rish uchun, saqlanmaydi).

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

## Privacy qoidasi (implementation talabi)

Yuz blur yoqilgan paytda kadr faqat quyidagi shart bajarilganda ko‘rsatiladi: detector tayyor, oxirgi detection muvaffaqiyatli va ≥1 yuz topilgan. Aks holda canvas’ga kadr chizilmaydi (shaffof qopqoq emas — kadr umuman chizilmaydi) va snapshot o‘chiriladi. Matnlarda “reduces exposure, not guaranteed anonymization” mazmuni saqlanadi. Ochiq: yuz bir lahzaga yo‘qolganda miltillashni kamaytirish uchun qisqa “ushlab turish” oynasi bo‘ladimi — bo‘lsa, faqat oxirgi bbox’lar blur bilan qoladi, yalang‘och kadr ko‘rsatilmaydi.

## Reuse va dependency

| Ehtiyoj | Mavjud kod | Reja |
| --- | --- | --- |
| Jonli yuz bbox | `app/detector.py` (Haar, server) — brauzerda ishlamaydi | MediaPipe **Face Detector** |
| Yuz blur | `app/blur.py::_obscure` (pixelate + Gauss), `AUTO_PADDING` 15% | Algoritm Canvas 2D’da qayta yoziladi, padding bir xil |
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

### Xavfsizlik headerlari (1-batch)

- CSP: `script-src 'self' 'wasm-unsafe-eval'`; kerak bo‘lsa `worker-src 'self' blob:`. Qolgani o‘zgarmaydi; CDN yo‘q.
- `Permissions-Policy: camera=(self)`.
- Kadr `<video>` → `<canvas>`; kadr uchun `fetch`/XHR yo‘q (network kuzatuvi bilan tekshiriladi).
- Kamera o‘chirilganda/sahifa yashirilganda `track.stop()`; snapshot blob URL’lari `revokeObjectURL`.

## Implementation batchlari

Commitlar `fix:` prefiksi bilan. Boshlanish sharti: Face Blur MVP va shu reja Codex review’dan o‘tgan.

1. **Kamera + jonli yuz blur.** Vendor (`tasks-vision` 1.0.1 + BlazeFace); EN/KO i18n infratuzilmasi (`app/static/i18n/`) va mavjud upload UI matnlarini ko‘chirish; to‘q tema; tablar; `camera.js` va barcha holatlar; Face Detector ~10–15 Hz, render har kadrda; canvas blur + 15% padding; privacy qoidasi; CSP/`Permissions-Policy` + testlar; mavjud 41 test; desktop/mobil brauzer tekshiruvi; FPS qurilma bilan qayd; README.
2. **Ko‘zoynak + snapshot.** Face Landmarker; ko‘z nuqtalari bo‘yicha joylash/burish, silliqlash; kompozit snapshot PNG, sessiya ro‘yxati.
3. **Fon blur / fon rasmi.** Image Segmenter; 4 ichki fon + foydalanuvchi rasmi (faqat brauzer xotirasida); chegara sifati va FPS ta’siri o‘lchanadi.

## Ochiq savollar

- Mavjud upload UI hozir o‘zbekcha; EN/KO’ga o‘tganda o‘zbekcha switcher’da qolmaydi — tasdiqlash kerak. README’dagi “UI shows this warning (in Uzbek)” jumlasi yangilanadi.
- Koreyscha tarjima — Claude qoralamasi, ona tilida so‘zlashuvchi tekshiruvi kerak.
- Privacy qoidasidagi “ushlab turish” oynasi (bor/yo‘q, davomiyligi).
- Model litsenziyalari model card’dan tasdiqlanishi kerak.
- Face detection evaluation rasmlari hali berilmagan.
