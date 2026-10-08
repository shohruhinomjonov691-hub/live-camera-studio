"""Region parsing and irreversible-looking blur (pixelate + Gaussian) on rectangles."""

import json
import math
from dataclasses import dataclass

import cv2
import numpy as np

from app.config import AUTO_PADDING, MAX_REGIONS, MAX_SIDE
from app.image_io import ImageError

SOURCES = ("auto", "manual")


@dataclass(frozen=True)
class Region:
    x: int
    y: int
    w: int
    h: int
    source: str = "manual"


def parse_regions(raw: str | None) -> list[Region]:
    """Parse the X-Regions header: a JSON list of {x, y, w, h, source} in original image pixels."""
    if raw is None or raw.strip() == "":
        return []
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        raise ImageError(400, "Hududlar JSON formatida emas.")
    if not isinstance(items, list):
        raise ImageError(400, "Hududlar ro‘yxat bo‘lishi kerak.")
    if len(items) > MAX_REGIONS:
        raise ImageError(400, f"Ko‘pi bilan {MAX_REGIONS} ta hudud yuborish mumkin.")

    regions = []
    for item in items:
        if not isinstance(item, dict):
            raise ImageError(400, "Har bir hudud obyekt bo‘lishi kerak.")
        values = []
        for key in ("x", "y", "w", "h"):
            value = item.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ImageError(400, f"Hududdagi '{key}' qiymati noto‘g‘ri.")
            # Check floats for NaN/inf, then compare against the bounds before any conversion:
            # JSON integers are unbounded, and math.isfinite(10**400) raises OverflowError.
            if isinstance(value, float) and not math.isfinite(value):
                raise ImageError(400, f"Hududdagi '{key}' qiymati noto‘g‘ri.")
            low = 0 if key in ("x", "y") else 1
            if not low <= value <= MAX_SIDE:
                raise ImageError(400, f"Hududdagi '{key}' qiymati {low}–{MAX_SIDE} oralig‘ida bo‘lishi kerak.")
            values.append(round(value))
        source = item.get("source", "manual")
        if source not in SOURCES:
            raise ImageError(400, "Hudud manbasi 'auto' yoki 'manual' bo‘lishi kerak.")
        x, y, w, h = values
        if w <= 0 or h <= 0:
            raise ImageError(400, "Hudud kengligi va balandligi musbat bo‘lishi kerak.")
        regions.append(Region(x, y, w, h, source))
    return regions


def to_pixel_box(region: Region, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Apply padding for automatic boxes and clip to the image. Returns (x0, y0, x1, y1) or None."""
    x0, y0, x1, y1 = region.x, region.y, region.x + region.w, region.y + region.h
    if region.source == "auto":
        pad_x = round(region.w * AUTO_PADDING)
        pad_y = round(region.h * AUTO_PADDING)
        x0, y0, x1, y1 = x0 - pad_x, y0 - pad_y, x1 + pad_x, y1 + pad_y
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _obscure(roi: np.ndarray) -> np.ndarray:
    h, w = roi.shape[:2]
    cells = 10  # roughly 10 blocks across the shorter side
    block = max(1, min(w, h) // cells)
    small = cv2.resize(roi, (max(1, w // block), max(1, h // block)), interpolation=cv2.INTER_AREA)
    pixelated = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    kernel = max(3, (min(w, h) // 4) | 1)
    return cv2.GaussianBlur(pixelated, (kernel, kernel), 0)


def blur_regions(pixels: np.ndarray, regions: list[Region]) -> np.ndarray:
    out = pixels.copy()
    height, width = out.shape[:2]
    for region in regions:
        box = to_pixel_box(region, width, height)
        if box is None:
            continue
        x0, y0, x1, y1 = box
        out[y0:y1, x0:x1] = _obscure(out[y0:y1, x0:x1])
    return out
