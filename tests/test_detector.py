import numpy as np

from app import detector
from app.detector import Box, detect_faces


def test_cascade_loads_and_blank_image_has_no_faces():
    assert detect_faces(np.full((200, 300, 3), 128, dtype=np.uint8)) == []


class FakeCascade:
    def __init__(self, found):
        self.found = found
        self.seen_shape = None

    def detectMultiScale(self, gray, **kwargs):
        self.seen_shape = gray.shape
        return np.array(self.found)


def test_boxes_are_mapped_back_from_downscaled_detection(monkeypatch):
    fake = FakeCascade([[10, 20, 30, 40]])
    monkeypatch.setattr(detector, "_get_cascade", lambda: fake)
    image = np.zeros((1280, 2560, 3), dtype=np.uint8)  # longest side 2560 -> detection scale 0.5

    boxes = detect_faces(image)

    assert fake.seen_shape == (640, 1280)
    assert boxes == [Box(20, 40, 60, 80)]


def test_boxes_are_clipped_to_the_image(monkeypatch):
    monkeypatch.setattr(detector, "_get_cascade", lambda: FakeCascade([[90, 90, 30, 30]]))
    boxes = detect_faces(np.zeros((100, 100, 3), dtype=np.uint8))
    assert boxes == [Box(90, 90, 10, 10)]
