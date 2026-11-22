"""Validate, decode and re-encode uploaded images entirely in memory."""

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import JPEG_QUALITY, MAX_PIXELS, MAX_SIDE, MAX_UPLOAD_BYTES

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
PNG_BIT_DEPTH_OFFSET = 24  # IHDR bit depth follows the signature, chunk header, width and height.

MEDIA_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png"}


class ImageError(Exception):
    """A client error. `code` is stable and translated by the UI; `message` is English, for debugging only."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
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
        raise ImageError(422, "corrupt_image", "Image dimensions are invalid.")
    if max(width, height) > MAX_SIDE:
        raise ImageError(413, "image_too_large", f"The longest side must be at most {MAX_SIDE} px.")
    if width * height > MAX_PIXELS:
        raise ImageError(413, "image_too_large", f"The image must be at most {MAX_PIXELS // 1_000_000} megapixels.")


def decode_image(data: bytes) -> DecodedImage:
    if not data:
        raise ImageError(400, "empty_file", "The file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ImageError(413, "file_too_large", f"The file must be at most {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")

    fmt = sniff_format(data)
    if fmt is None:
        raise ImageError(415, "unsupported_format", "Only JPEG or PNG images are accepted.")

    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format != fmt:
                raise ImageError(415, "unsupported_format", "The file content does not match JPEG or PNG.")
            # Header-only size check before decoding pixel data.
            check_dimensions(*img.size)
            img.load()
            if fmt == "PNG" and "transparency" in img.info:
                _prepare_png_transparency(img, data)
            oriented = ImageOps.exif_transpose(img)
            rgb = _to_rgb(oriented)
            pixels = np.array(rgb, dtype=np.uint8)
    except ImageError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError, cv2.error):
        raise ImageError(422, "corrupt_image", "The image could not be decoded.")

    return DecodedImage(pixels=pixels, format=fmt)


def _prepare_png_transparency(img: Image.Image, data: bytes) -> None:
    bit_depth = data[PNG_BIT_DEPTH_OFFSET]
    if img.mode == "L" and bit_depth in (2, 4):
        # Pillow expands the pixels to 8 bits but keeps the transparent sample at its original bit depth.
        img.info["transparency"] *= 255 // ((1 << bit_depth) - 1)
    elif img.mode == "RGB" and bit_depth == 16:
        # Pillow drops the low bytes of RGB pixels. OpenCV expands tRNS using the full 16-bit samples.
        bgra = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if bgra is None or bgra.shape != (img.height, img.width, 4) or bgra.dtype != np.uint16:
            raise ImageError(422, "corrupt_image", "The image could not be decoded.")
        img.paste((255, 255, 255), mask=Image.fromarray(bgra[:, :, 3] == 0))
        del img.info["transparency"]


def _to_rgb(img: Image.Image) -> Image.Image:
    if img.mode == "I;16" and "transparency" in img.info:
        # Compare the 16-bit grayscale samples before Pillow reduces them to RGB.
        rgb = img.convert("RGB")
        rgb.paste((255, 255, 255), mask=Image.fromarray(np.asarray(img) == img.info["transparency"]))
        return rgb
    if img.has_transparency_data:
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
