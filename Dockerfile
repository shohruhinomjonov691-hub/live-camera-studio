# Live Camera Studio — production image.
# Python 3.13: the pinned dependencies (numpy 2.5, opencv-python-headless 4.14, Pillow 12.3) are tested on 3.13.
# Tag and digest are pinned; update both together.
FROM python:3.13.16-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/live-camera-studio

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The app, including the vendored MediaPipe package and models under app/static/vendor/ (no CDN at runtime).
COPY app ./app
COPY LICENSE README.md ./

# Unprivileged user; the image needs no write access at runtime (run with a read-only root filesystem).
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin app
USER 10001:10001

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"]

# 0.0.0.0 inside the container only; compose publishes the port on 127.0.0.1 for the host's Nginx.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
