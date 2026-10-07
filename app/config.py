"""Limits and detector settings. Values are deliberately conservative for a CPU-only MVP."""

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_PIXELS = 25_000_000  # 25 megapixels
MAX_SIDE = 8000  # longest allowed side in pixels
MAX_REGIONS = 100

# Detection runs on a downscaled grayscale copy; boxes are mapped back to original pixels.
DETECT_MAX_SIDE = 1280
SCALE_FACTOR = 1.1
MIN_NEIGHBORS = 5
MIN_FACE_SIZE = 24  # pixels, on the downscaled detection image

# Automatic boxes are grown on every side so hair/chin edges are covered too.
AUTO_PADDING = 0.15

JPEG_QUALITY = 90
