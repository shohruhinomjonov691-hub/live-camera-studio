import io
import json
import logging
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from tests.conftest import GPS_IFD, decode, make_jpeg, make_png, noise_pixels

PROJECT_DIR = Path(__file__).resolve().parents[1]


def test_health_and_index(client):
    assert client.get("/health").json() == {"status": "ok"}
    page = client.get("/")
    assert page.status_code == 200
    assert "Avtomatik aniqlash barcha yuzlarni topishni kafolatlamaydi" in page.text


def test_detect_returns_dimensions_and_faces(client):
    response = client.post("/api/detect", content=make_jpeg(80, 60), headers={"Content-Type": "image/jpeg"})
    assert response.status_code == 200
    body = response.json()
    assert (body["width"], body["height"]) == (80, 60)
    assert body["count"] == len(body["faces"])
    assert response.headers["cache-control"] == "no-store"


def test_detect_reports_oriented_dimensions(client):
    body = client.post("/api/detect", content=make_jpeg(40, 20, orientation=6)).json()
    assert (body["width"], body["height"]) == (20, 40)


@pytest.mark.parametrize(
    ("payload", "status"),
    [(b"", 400), (b"plain text", 415), (b"\x89PNG\r\n\x1a\n" + b"\x00" * 50, 422)],
)
def test_detect_rejects_bad_files(client, payload, status):
    response = client.post("/api/detect", content=payload)
    assert response.status_code == status
    assert "detail" in response.json()


def test_rejects_body_over_limit(client, monkeypatch):
    monkeypatch.setattr("app.main.MAX_UPLOAD_BYTES", 1000)
    response = client.post("/api/detect", content=make_jpeg(200, 200))
    assert response.status_code == 413


def test_rejects_declared_content_length_over_limit(client):
    response = client.post(
        "/api/detect",
        content=b"x",
        headers={"Content-Length": str(50 * 1024 * 1024)},
    )
    assert response.status_code == 413


def test_blur_jpeg_blurs_region_and_strips_metadata(client):
    pixels = noise_pixels(100, 80, seed=3)
    source = make_jpeg(pixels=pixels, gps=True, quality=95)
    regions = [{"x": 10, "y": 10, "w": 40, "h": 30, "source": "manual"}]

    response = client.post("/api/blur", content=source, headers={"X-Regions": json.dumps(regions)})

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "no-store"
    with Image.open(io.BytesIO(response.content)) as img:
        assert img.size == (100, 80)
        assert len(img.getexif()) == 0
        assert GPS_IFD not in img.getexif()
    out = decode(response.content).astype(float)
    original = decode(source).astype(float)
    inside = (slice(10, 40), slice(10, 50))
    assert out[inside].std() < original[inside].std() / 2  # region is smoothed
    outside = (slice(50, 80), slice(60, 100))
    assert np.abs(out[outside] - original[outside]).mean() < 8  # only JPEG re-encode noise


def test_blur_keeps_png_format(client):
    response = client.post("/api/blur", content=make_png(40, 30), headers={"X-Regions": "[]"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"


def test_blur_maps_manual_region_in_oriented_coordinates(client):
    # Stored 40x20 with orientation 6 -> displayed/processed as 20x40.
    response = client.post(
        "/api/blur",
        content=make_jpeg(40, 20, orientation=6),
        headers={"X-Regions": json.dumps([{"x": 0, "y": 30, "w": 20, "h": 10}])},
    )
    assert response.status_code == 200
    with Image.open(io.BytesIO(response.content)) as img:
        assert img.size == (20, 40)


def test_blur_rejects_bad_regions(client):
    response = client.post("/api/blur", content=make_jpeg(), headers={"X-Regions": "{oops"})
    assert response.status_code == 400


@pytest.mark.parametrize(
    "raw",
    [
        '[{"x": 1' + "0" * 400 + ', "y": 0, "w": 5, "h": 5}]',  # overflowed math.isfinite -> 500
        '[{"x": 1' + "0" * 4400 + ', "y": 0, "w": 5, "h": 5}]',  # 4401 digits: json.loads ValueError -> 500
        '[{"x": 1e400, "y": 0, "w": 5, "h": 5}]',
        '[{"x": 0, "y": 0, "w": 99999, "h": 5}]',
        '[{"x": -5, "y": 0, "w": 5, "h": 5}]',
    ],
)
def test_blur_rejects_out_of_range_coordinates_with_400(client, raw):
    response = client.post("/api/blur", content=make_jpeg(), headers={"X-Regions": raw})
    assert response.status_code == 400
    assert "detail" in response.json()


_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC
_audit = {"active": False, "writes": []}


def _audit_hook(event, args):
    # Fires for every open() in the process, including unlinked tempfile.TemporaryFile on POSIX.
    if not _audit["active"] or event != "open":
        return
    path, mode, flags = args
    writes = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
        isinstance(flags, int) and flags & _WRITE_FLAGS
    )
    if writes:
        _audit["writes"].append(path)


sys.addaudithook(_audit_hook)


def _listing(path: Path) -> set[str]:
    return {str(p) for p in path.rglob("*") if "__pycache__" not in p.parts and ".pytest_cache" not in p.parts}


def test_large_upload_creates_no_files_and_logs_no_image_data(client, monkeypatch, caplog):
    """Uploads above Starlette's 1 MB spool threshold must still stay in memory."""
    payload = make_jpeg(pixels=noise_pixels(1400, 1400, seed=7), quality=95)
    assert len(payload) > 1024 * 1024

    def forbidden(*args, **kwargs):
        raise AssertionError("temporary file creation is not allowed")

    for name in ("TemporaryFile", "NamedTemporaryFile", "SpooledTemporaryFile", "mkstemp", "mkdtemp"):
        monkeypatch.setattr(tempfile, name, forbidden)

    temp_dir = Path(tempfile.gettempdir())
    temp_before = set(os.listdir(temp_dir))
    project_before = _listing(PROJECT_DIR)

    caplog.set_level(logging.DEBUG)
    _audit["writes"] = []
    _audit["active"] = True
    try:
        detect = client.post("/api/detect", content=payload)
        blur = client.post(
            "/api/blur",
            content=payload,
            headers={"X-Regions": json.dumps([{"x": 100, "y": 100, "w": 300, "h": 300}])},
        )
    finally:
        _audit["active"] = False

    assert _audit["writes"] == []
    assert detect.status_code == 200
    assert blur.status_code == 200
    assert set(os.listdir(temp_dir)) - temp_before == set()
    assert _listing(PROJECT_DIR) == project_before
    for record in caplog.records:
        message = record.getMessage()
        assert len(message) < 1000
        assert "�" not in message and "JFIF" not in message
