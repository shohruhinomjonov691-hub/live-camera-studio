"""Face Blur API. Uploaded images are processed in memory only and never written to disk, logs or a DB.

The request body is read as raw bytes (not multipart/UploadFile), because Starlette's UploadFile
spools large uploads to a temporary file on disk.
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app.blur import Region, blur_regions, parse_regions
from app.config import MAX_UPLOAD_BYTES
from app.detector import detect_faces
from app.image_io import MEDIA_TYPES, ImageError, decode_image, encode_image

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Face Blur", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    # 'wasm-unsafe-eval' lets the vendored MediaPipe WebAssembly compile; it does not allow JS eval.
    # The same header is sent with the worker script, which is where the detector runs.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; "
        "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ImageError)
async def image_error_handler(request: Request, exc: ImageError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"code": exc.code, "detail": exc.message})


async def read_limited_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise ImageError(413, "file_too_large", f"The file must be at most {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_UPLOAD_BYTES:
            raise ImageError(413, "file_too_large", f"The file must be at most {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    return bytes(body)


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/detect")
async def detect(request: Request) -> JSONResponse:
    data = await read_limited_body(request)
    image = await run_in_threadpool(decode_image, data)
    boxes = await run_in_threadpool(detect_faces, image.pixels)
    return JSONResponse(
        {
            "width": image.width,
            "height": image.height,
            "count": len(boxes),
            "faces": [{"x": b.x, "y": b.y, "w": b.w, "h": b.h} for b in boxes],
        }
    )


def _blur_and_encode(data: bytes, regions: list[Region]) -> tuple[bytes, str]:
    image = decode_image(data)
    blurred = blur_regions(image.pixels, regions)
    return encode_image(blurred, image.format), image.format


@app.post("/api/blur")
async def blur(request: Request) -> Response:
    regions = parse_regions(request.headers.get("x-regions"))
    data = await read_limited_body(request)
    content, fmt = await run_in_threadpool(_blur_and_encode, data, regions)
    return Response(content=content, media_type=MEDIA_TYPES[fmt])
