"""Validate, decode and re-encode uploaded images entirely in memory."""

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import JPEG_QUALITY, MAX_PIXELS, MAX_SIDE, MAX_UPLOAD_BYTES

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

MEDIA_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png"}


class ImageError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


@dataclass
class DecodedImage:
    pixels: np.ndarray  # RGB, uint8, shape (height, width, 3), EXIF orientation applied
    format: str  # "JPEG" or "PNG"

    @property
    def width(self) -> int:
        return int(self.pixels.shape[1])

    @property
    def height(self) -> int:
        return int(self.pixels.shape[0])


def sniff_format(data: bytes) -> str | None:
    """Detect the real format from magic bytes, ignoring file name and Content-Type."""
    if data.startswith(JPEG_MAGIC):
        return "JPEG"
    if data.startswith(PNG_MAGIC):
        return "PNG"
    return None


def check_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise ImageError(422, "Rasm o‘lchami noto‘g‘ri.")
    if max(width, height) > MAX_SIDE:
        raise ImageError(413, f"Rasm tomoni {MAX_SIDE} pikseldan oshmasligi kerak.")
    if width * height > MAX_PIXELS:
        raise ImageError(413, f"Rasm {MAX_PIXELS // 1_000_000} megapikseldan oshmasligi kerak.")


def decode_image(data: bytes) -> DecodedImage:
    if not data:
        raise ImageError(400, "Fayl bo‘sh.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ImageError(413, f"Fayl {MAX_UPLOAD_BYTES // (1024 * 1024)} MB dan oshmasligi kerak.")

    fmt = sniff_format(data)
    if fmt is None:
        raise ImageError(415, "Faqat JPEG yoki PNG rasm qabul qilinadi.")

    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format != fmt:
                raise ImageError(415, "Fayl mazmuni JPEG yoki PNG formatiga mos emas.")
            # Header-only size check before decoding pixel data.
            check_dimensions(*img.size)
            img.load()
            oriented = ImageOps.exif_transpose(img)
            rgb = _to_rgb(oriented)
            pixels = np.array(rgb, dtype=np.uint8)
    except ImageError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise ImageError(422, "Rasmni o‘qib bo‘lmadi: fayl buzilgan yoki qo‘llab-quvvatlanmaydi.")

    return DecodedImage(pixels=pixels, format=fmt)


def _to_rgb(img: Image.Image) -> Image.Image:
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    if has_alpha:
        rgba = img.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return img.convert("RGB")


def encode_image(pixels: np.ndarray, fmt: str) -> bytes:
    """Encode a fresh image from raw pixels, so no EXIF, GPS, ICC or text metadata is carried over."""
    img = Image.fromarray(pixels)
    buffer = io.BytesIO()
    if fmt == "PNG":
        img.save(buffer, format="PNG")
    else:
        img.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue()
