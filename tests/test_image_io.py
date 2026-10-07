import io

import numpy as np
import pytest
from PIL import Image

from app import config
from app.image_io import ImageError, decode_image, encode_image, sniff_format
from tests.conftest import GPS_IFD, make_jpeg, make_png


def status_of(data: bytes) -> int:
    with pytest.raises(ImageError) as info:
        decode_image(data)
    return info.value.status_code


def test_sniff_uses_magic_bytes_not_names():
    assert sniff_format(make_jpeg()) == "JPEG"
    assert sniff_format(make_png()) == "PNG"
    assert sniff_format(b"GIF89a....") is None
    assert sniff_format(b"hello world") is None


def test_rejects_empty_and_non_images():
    assert status_of(b"") == 400
    assert status_of(b"not an image at all") == 415
    gif = io.BytesIO()
    Image.new("RGB", (4, 4)).save(gif, format="GIF")
    assert status_of(gif.getvalue()) == 415


def test_rejects_corrupt_data_behind_valid_magic():
    assert status_of(b"\xff\xd8\xff" + b"\x00" * 200) == 422
    assert status_of(make_png()[:40]) == 422  # truncated PNG
    assert status_of(make_jpeg(400, 300)[:600]) == 422  # truncated JPEG


def test_rejects_oversized_file(monkeypatch):
    monkeypatch.setattr("app.image_io.MAX_UPLOAD_BYTES", 1000)
    assert status_of(make_jpeg(200, 200)) == 413


def test_rejects_too_many_pixels_and_too_long_side():
    big = io.BytesIO()
    Image.new("L", (6000, 5000)).save(big, format="PNG")  # 30 MP, compresses to a small file
    assert status_of(big.getvalue()) == 413
    long = io.BytesIO()
    Image.new("L", (config.MAX_SIDE + 1, 10)).save(long, format="PNG")
    assert status_of(long.getvalue()) == 413


def test_applies_exif_orientation():
    decoded = decode_image(make_jpeg(40, 20, orientation=6))  # rotate 90°
    assert (decoded.width, decoded.height) == (20, 40)
    assert decoded.format == "JPEG"


def test_flattens_png_alpha_onto_white():
    decoded = decode_image(make_png(10, 10, mode="RGBA"))
    assert decoded.format == "PNG"
    assert decoded.pixels.shape == (10, 10, 3)
    assert np.all(decoded.pixels == 255)


def test_encoded_jpeg_has_no_exif_or_gps():
    source = make_jpeg(60, 40, gps=True)
    with Image.open(io.BytesIO(source)) as original:
        assert GPS_IFD in original.getexif()  # fixture really carries GPS

    out = encode_image(decode_image(source).pixels, "JPEG")
    with Image.open(io.BytesIO(out)) as img:
        assert img.format == "JPEG"
        assert len(img.getexif()) == 0
        assert "exif" not in img.info
        assert "icc_profile" not in img.info
    assert b"Exif" not in out
    assert b"TestCam" not in out


def test_encoded_png_has_no_text_chunks():
    source = make_png(30, 20, text="secret note")
    out = encode_image(decode_image(source).pixels, "PNG")
    with Image.open(io.BytesIO(out)) as img:
        assert img.format == "PNG"
        assert "Comment" not in img.info
    assert b"secret note" not in out
