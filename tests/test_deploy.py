"""Static guards for the deployment files. deploy/smoke/check.sh is the behavioural check (needs Docker)."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def directives(text: str) -> dict[str, str]:
    found = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line.endswith(";") and " " in line:
            name, value = line[:-1].split(None, 1)
            found.setdefault(name, value.strip())
    return found


def megabytes(value: str) -> int:
    match = re.fullmatch(r"(\d+)([mk]?)", value)
    assert match, value
    number, unit = int(match.group(1)), match.group(2)
    return number if unit == "m" else number // 1024 if unit == "k" else number // (1024 * 1024)


def test_nginx_proxy_never_spools_images_to_disk():
    d = directives(read("deploy/nginx/live-camera-studio-proxy.conf"))
    assert d["proxy_request_buffering"] == "off"
    assert d["proxy_buffering"] == "off"
    assert d["proxy_max_temp_file_size"] == "0"
    assert d["client_body_in_file_only"] == "off"
    # A body Nginx has to hold must fit in memory: buffer >= the accepted body size (>= the app's 10 MB limit).
    assert megabytes(d["client_body_buffer_size"]) >= megabytes(d["client_max_body_size"]) >= 10


def test_nginx_proxy_does_not_override_app_security_headers():
    text = read("deploy/nginx/live-camera-studio-proxy.conf")
    for header in ("Content-Security-Policy", "Permissions-Policy", "Cache-Control"):
        assert not re.search(rf"^\s*(add_header|proxy_hide_header)\s+{header}", text, re.M | re.I), header


def test_compose_is_isolated_and_hardened():
    text = read("compose.yaml")
    assert re.search(r"^name: live-camera-studio$", text, re.M)
    assert '"127.0.0.1:${LCS_PORT:-18765}:8000"' in text, "published on loopback only"
    assert "read_only: true" in text
    assert "no-new-privileges:true" in text
    assert re.search(r"cap_drop:\s*\n\s*- ALL", text)


def test_dockerfile_runs_unprivileged_with_healthcheck_and_pinned_base():
    text = read("Dockerfile")
    assert re.search(r"^FROM python:3\.13\.\d+-slim-bookworm@sha256:[0-9a-f]{64}$", text, re.M)
    assert re.search(r"^USER 10001:10001$", text, re.M)
    assert "HEALTHCHECK" in text and "/health" in text
    assert re.search(r"^COPY app \./app$", text, re.M), "vendored models are part of the image"
    ignored = read(".dockerignore").split()
    assert "app" not in ignored and ".git" in ignored and ".venv" in ignored


def test_license_is_mit_and_keeps_vendor_licenses():
    assert read("LICENSE").startswith("MIT License")
    assert (ROOT / "app/static/vendor/mediapipe/LICENSE").read_text().lstrip().startswith("Apache License")
