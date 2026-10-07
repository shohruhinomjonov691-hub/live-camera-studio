import json

import numpy as np
import pytest

from app import config
from app.blur import Region, blur_regions, parse_regions, to_pixel_box
from app.image_io import ImageError
from tests.conftest import noise_pixels


def test_parse_regions_valid():
    raw = json.dumps([{"x": 1, "y": 2, "w": 3.4, "h": 4.6, "source": "auto"}, {"x": 0, "y": 0, "w": 5, "h": 5}])
    assert parse_regions(raw) == [Region(1, 2, 3, 5, "auto"), Region(0, 0, 5, 5, "manual")]
    assert parse_regions(None) == []
    assert parse_regions("  ") == []


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        json.dumps({"x": 1}),
        json.dumps([1, 2]),
        json.dumps([{"x": 1, "y": 1, "w": 0, "h": 5}]),
        json.dumps([{"x": 1, "y": 1, "w": -3, "h": 5}]),
        json.dumps([{"x": "1", "y": 1, "w": 3, "h": 5}]),
        json.dumps([{"x": True, "y": 1, "w": 3, "h": 5}]),
        json.dumps([{"y": 1, "w": 3, "h": 5}]),
        json.dumps([{"x": 1, "y": 1, "w": 3, "h": 5, "source": "other"}]),
        '[{"x": NaN, "y": 1, "w": 3, "h": 5}]',
    ],
)
def test_parse_regions_rejects_invalid(raw):
    with pytest.raises(ImageError) as info:
        parse_regions(raw)
    assert info.value.status_code == 400


def test_parse_regions_limits_count():
    raw = json.dumps([{"x": 0, "y": 0, "w": 1, "h": 1}] * (config.MAX_REGIONS + 1))
    with pytest.raises(ImageError):
        parse_regions(raw)


def test_auto_regions_are_padded_and_clipped():
    assert to_pixel_box(Region(10, 10, 20, 20, "auto"), 100, 100) == (7, 7, 33, 33)
    assert to_pixel_box(Region(10, 10, 20, 20, "manual"), 100, 100) == (10, 10, 30, 30)
    assert to_pixel_box(Region(90, 90, 50, 50, "manual"), 100, 100) == (90, 90, 100, 100)
    assert to_pixel_box(Region(-20, -20, 10, 10, "manual"), 100, 100) is None
    assert to_pixel_box(Region(200, 5, 10, 10, "manual"), 100, 100) is None


def test_blur_changes_only_the_region():
    pixels = noise_pixels(120, 80, seed=1)
    out = blur_regions(pixels, [Region(20, 10, 40, 30, "manual")])
    inside = (slice(10, 40), slice(20, 60))
    assert not np.array_equal(out[inside], pixels[inside])
    mask = np.ones(pixels.shape[:2], dtype=bool)
    mask[inside] = False
    assert np.array_equal(out[mask], pixels[mask])
    # The obscured patch is much smoother than the random source.
    assert out[inside].astype(float).std() < pixels[inside].astype(float).std() / 2
    # Input is not modified in place.
    assert not np.shares_memory(out, pixels)


def test_blur_without_regions_is_identity():
    pixels = noise_pixels(30, 20)
    assert np.array_equal(blur_regions(pixels, []), pixels)


def test_tiny_and_edge_regions_do_not_crash():
    pixels = noise_pixels(10, 10)
    out = blur_regions(pixels, [Region(9, 9, 1, 1, "manual"), Region(0, 0, 2, 10, "auto")])
    assert out.shape == pixels.shape
