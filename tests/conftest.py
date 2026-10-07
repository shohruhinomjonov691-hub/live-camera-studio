import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

GPS_IFD = 0x8825
ORIENTATION = 0x0112


def noise_pixels(width: int, height: int, seed: int = 0) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 256, (height, width, 3), dtype=np.uint8)


def make_jpeg(width=64, height=48, *, pixels=None, orientation=None, gps=False, quality=90) -> bytes:
    img = Image.fromarray(pixels if pixels is not None else noise_pixels(width, height))
    exif = Image.Exif()
    exif[0x010F] = "TestCam"  # Make
    if orientation is not None:
        exif[ORIENTATION] = orientation
    if gps:
        exif[GPS_IFD] = {1: "N", 2: (37.0, 33.0, 0.0), 3: "E", 4: (126.0, 58.0, 0.0)}
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=quality, exif=exif)
    return buffer.getvalue()


def make_png(width=64, height=48, *, mode="RGB", text=None) -> bytes:
    if mode == "RGBA":
        img = Image.new("RGBA", (width, height), (255, 0, 0, 0))
    else:
        img = Image.fromarray(noise_pixels(width, height))
    buffer = io.BytesIO()
    if text:
        from PIL.PngImagePlugin import PngInfo

        info = PngInfo()
        info.add_text("Comment", text)
        img.save(buffer, format="PNG", pnginfo=info)
    else:
        img.save(buffer, format="PNG")
    return buffer.getvalue()


def decode(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as img:
        return np.array(img.convert("RGB"))


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)
