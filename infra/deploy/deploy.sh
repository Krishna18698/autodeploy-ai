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
# SMALL=1: the 1 OCPU / 6 GB profile (docker-compose.small.yml).
files=(-f docker-compose.prod.yml)
[ "${SMALL:-}" = 1 ] && files+=(-f docker-compose.small.yml)
apis=(api-1 api-2)
[ "${SMALL:-}" = 1 ] && apis=(api-1)
compose() { docker compose --env-file .env.prod "${files[@]}" "$@"; }

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

# SKIP_PULL=1 when ship.sh built the images on this VM.
[ "${SKIP_PULL:-}" = 1 ] || compose pull "${apis[@]}" worker egress
compose up -d --remove-orphans postgres valkey kafka egress caddy
for svc in "${apis[@]}"; do
  echo "▸ rolling $svc"
  compose up -d --no-deps "$svc"
  wait_healthy "$svc"
done
echo "▸ draining and replacing worker"
compose up -d --no-deps worker
wait_healthy worker
echo "✓ deployed $IMAGE_TAG"
