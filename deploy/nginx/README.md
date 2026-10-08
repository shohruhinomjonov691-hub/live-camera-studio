# Deploying behind the existing Nginx (camera.gotrips.cloud)

Target: Nginx 1.24.0 already running on the host, HTTPS via Let's Encrypt (certbot), no second proxy.
These steps add one new site and one new certificate; they do not modify other sites, their certificates or
their deploy procedures.

## 0. Prerequisites

- DNS: an `A` (and, if the server has IPv6, `AAAA`) record for `camera.gotrips.cloud` pointing at the server.
  Check: `dig +short camera.gotrips.cloud`.
- The app is running: `docker compose up -d --build --wait` in the repo, then
  `curl -s http://127.0.0.1:18765/health` returns `{"status":"ok"}`.
- Look before changing anything:
  `nginx -v` (expect 1.24.0), `ls /etc/nginx/sites-enabled/ /etc/nginx/conf.d/`, and
  `grep -RIn "listen .*443" /etc/nginx/` to see whether the existing sites use `http2` on port 443.

## 1. HTTP bootstrap (no certificate yet)

```bash
sudo install -d -m 755 /var/www/live-camera-studio-acme
sudo install -m 644 deploy/nginx/live-camera-studio-proxy.conf /etc/nginx/snippets/live-camera-studio-proxy.conf
sudo install -m 644 deploy/nginx/live-camera-studio.bootstrap.conf.example /etc/nginx/sites-available/live-camera-studio.conf
sudo ln -s /etc/nginx/sites-available/live-camera-studio.conf /etc/nginx/sites-enabled/live-camera-studio.conf
sudo nginx -t && sudo systemctl reload nginx
```

(If the server uses `conf.d/` instead of `sites-*`, put the file at `/etc/nginx/conf.d/live-camera-studio.conf`.)

## 2. Issue the certificate (webroot mode)

```bash
sudo certbot certonly --webroot -w /var/www/live-camera-studio-acme -d camera.gotrips.cloud \
  --deploy-hook "systemctl reload nginx"
```

Webroot mode only adds `/etc/letsencrypt/live/camera.gotrips.cloud/`; it does not edit Nginx files or other
certificates. Do not use `certbot --nginx`, which rewrites server blocks.

## 3. Final HTTPS site

```bash
sudo install -m 644 deploy/nginx/live-camera-studio.conf.example /etc/nginx/sites-available/live-camera-studio.conf
sudo nginx -t && sudo systemctl reload nginx
```

HTTP/2 on Nginx 1.24 is the `http2` parameter of `listen` and is shared by every site on the same address:port.
If step 0 showed that the existing sites on 443 do **not** use `http2`, remove `http2` from the two `listen 443`
lines before installing (the site then serves HTTP/1.1), so the other sites are not switched to HTTP/2.

## 4. Verify

```bash
curl -sI https://camera.gotrips.cloud/ | grep -iE "^HTTP|content-security-policy|permissions-policy"
curl -s https://camera.gotrips.cloud/health
sudo grep -c "buffered to a temporary file" /var/log/nginx/live-camera-studio.error.log   # expect 0 after uploads
```

Then upload a photo larger than 1 MB in the app and check the error log again. `sudo certbot renew --dry-run`
checks renewals.

## Rollback

Remove the symlink (or the conf.d file) and reload Nginx; the other sites are unaffected.

## Local checks (no server needed)

- `deploy/nginx/check-config.sh` runs `nginx -t` with Nginx 1.24.0 in Docker against both site files (with a
  throwaway self-signed certificate at the real certificate paths).
- `deploy/smoke/check.sh` runs the app behind Nginx 1.24.0 with the proxy snippet and fails if image traffic is
  buffered to disk or if `/api/detect` / `/api/blur` do not return valid results.
