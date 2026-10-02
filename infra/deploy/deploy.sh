#!/usr/bin/env bash
# Zero-downtime deploy on the VM:  IMAGE_TAG=<git sha> ./deploy.sh
#   1. pull new images
#   2. api-1 restarts first and runs migrations (advisory-locked); Caddy
#      routes around it until /readyz passes; then api-2
#   3. worker gets SIGTERM: it stops claiming, gives in-flight builds 20 s,
#      releases their leases for another run, then exits; the new one starts
set -euo pipefail
cd "$(dirname "$0")"
: "${IMAGE_TAG:?set IMAGE_TAG to the image tag to deploy}"
export IMAGE_TAG
compose() { docker compose --env-file .env.prod -f docker-compose.prod.yml "$@"; }

wait_healthy() {
  local svc=$1
  for _ in $(seq 1 60); do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q "$svc")" 2>/dev/null || echo starting)
    [ "$state" = healthy ] && return 0
    sleep 2
  done
  echo "✗ $svc did not become healthy" >&2
  return 1
}

compose pull api-1 api-2 worker egress
compose up -d postgres valkey kafka egress caddy cloudflared
for svc in api-1 api-2; do
  echo "▸ rolling $svc"
  compose up -d --no-deps "$svc"
  wait_healthy "$svc"
done
echo "▸ draining and replacing worker"
compose up -d --no-deps worker
wait_healthy worker
echo "✓ deployed $IMAGE_TAG"
