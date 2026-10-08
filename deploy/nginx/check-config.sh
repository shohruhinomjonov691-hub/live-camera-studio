#!/usr/bin/env bash
# nginx -t with Nginx 1.24.0 (the server's version) for both site files and the proxy snippet.
# A throwaway self-signed certificate is mounted at the real certificate paths; nothing else is needed.
set -euo pipefail
cd "$(dirname "$0")"
image="nginx:1.24.0-alpine"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=camera.gotrips.cloud" \
  -keyout "$work/privkey.pem" -out "$work/fullchain.pem" >/dev/null 2>&1

check() {  # site file
  docker run --rm \
    -v "$PWD/live-camera-studio-proxy.conf:/etc/nginx/snippets/live-camera-studio-proxy.conf:ro" \
    -v "$PWD/$1:/etc/nginx/conf.d/default.conf:ro" \
    -v "$work:/etc/letsencrypt/live/camera.gotrips.cloud:ro" \
    --entrypoint nginx "$image" -t 2>&1 | grep -E "syntax is ok|test is successful|emerg|warn" || true
}

status=0
for site in ${SITES:-live-camera-studio.bootstrap.conf.example live-camera-studio.conf.example}; do
  echo "== $site ($image)"
  out="$(check "$site")"
  echo "$out"
  echo "$out" | grep -q "test is successful" || status=1
done
[ "$status" -eq 0 ] && echo "PASS" || { echo "FAIL"; exit 1; }
