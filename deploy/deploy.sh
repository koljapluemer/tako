#!/usr/bin/env bash
# Deploy the committed HEAD next to other apps behind an existing Caddy container.
# Safe to re-run. Target settings live in deploy/.env (see deploy/.env.example).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [ -f deploy/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . deploy/.env
  set +a
fi

host=${TAKO_DEPLOY_HOST:?set TAKO_DEPLOY_HOST in deploy/.env}
domain=${TAKO_DOMAIN:?set TAKO_DOMAIN in deploy/.env}
proxy_network=${PROXY_NETWORK:?set PROXY_NETWORK in deploy/.env}
caddy_container=${CADDY_CONTAINER:?set CADDY_CONTAINER in deploy/.env}
caddyfile=${CADDYFILE:?set CADDYFILE in deploy/.env}
remote_dir=${TAKO_REMOTE_DIR:-tako}

tag=$(git rev-parse --short HEAD)

echo "==> building tako-viewer:$tag from committed HEAD"
git archive --format=tar HEAD | docker build -t "tako-viewer:$tag" -

echo "==> loading image on $host"
docker save "tako-viewer:$tag" | gzip | ssh "$host" docker load

echo "==> starting viewer"
ssh "$host" "mkdir -p '$remote_dir'"
scp -q deploy/compose.yaml "$host:$remote_dir/compose.yaml"
ssh "$host" "cd '$remote_dir' && umask 077 &&
  printf 'TAKO_TAG=%s\nPROXY_NETWORK=%s\n' '$tag' '$proxy_network' > .env &&
  docker compose up -d --wait --wait-timeout 90"

echo "==> ensuring Caddy routes $domain"
# The Caddyfile is a single-file bind mount: write in place (never mv or sed -i),
# otherwise the container keeps seeing the old inode.
ssh "$host" bash -s -- "$domain" "$caddy_container" "$caddyfile" <<'REMOTE'
set -euo pipefail
domain=$1 container=$2 file=$3
if ! grep -qF "$domain {" "$file"; then
  backup="$file.before-tako"
  cp -p "$file" "$backup"
  printf '\n%s {\n  encode zstd gzip\n  reverse_proxy tako-viewer:80\n}\n' "$domain" >> "$file"
  if ! docker exec "$container" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cat "$backup" > "$file"
    echo "Caddy rejected the new config; restored the previous file" >&2
    exit 1
  fi
  docker exec "$container" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi
REMOTE

echo "==> smoke test https://$domain/"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$domain/"; then
    echo "deployed $tag to https://$domain/"
    exit 0
  fi
  sleep 2
done
echo "https://$domain/ did not become healthy" >&2
exit 1
