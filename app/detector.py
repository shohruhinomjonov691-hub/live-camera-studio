"""Frontal face detection with OpenCV's bundled Haar cascade (reused from cv_opencv.ipynb)."""

import threading
from dataclasses import dataclass

import cv2
import numpy as np

from app.config import DETECT_MAX_SIDE, MIN_FACE_SIZE, MIN_NEIGHBORS, SCALE_FACTOR

CASCADE_PATH = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"

_cascade: cv2.CascadeClassifier | None = None
# CascadeClassifier is not documented as thread-safe; requests run in a thread pool.
_lock = threading.Lock()


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int


def _get_cascade() -> cv2.CascadeClassifier:
    global _cascade
    if _cascade is None:
        cascade = cv2.CascadeClassifier(CASCADE_PATH)
        if cascade.empty():
            raise RuntimeError(f"Haar cascade could not be loaded from {CASCADE_PATH}")
        _cascade = cascade
    return _cascade


def detect_faces(rgb: np.ndarray) -> list[Box]:
    height, width = rgb.shape[:2]
    scale = min(1.0, DETECT_MAX_SIDE / max(height, width))

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if scale < 1.0:
        size = (max(1, round(width * scale)), max(1, round(height * scale)))
        gray = cv2.resize(gray, size, interpolation=cv2.INTER_AREA)
    gray = cv2.equalizeHist(gray)

    with _lock:
        found = _get_cascade().detectMultiScale(
            gray,
            scaleFactor=SCALE_FACTOR,
            minNeighbors=MIN_NEIGHBORS,
            minSize=(MIN_FACE_SIZE, MIN_FACE_SIZE),
        )

    boxes = []
    for x, y, w, h in found:
        x0 = max(0, round(x / scale))
        y0 = max(0, round(y / scale))
        x1 = min(width, round((x + w) / scale))
        y1 = min(height, round((y + h) / scale))
        if x1 > x0 and y1 > y0:
            boxes.append(Box(x0, y0, x1 - x0, y1 - y0))
    return boxes
