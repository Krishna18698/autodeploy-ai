#!/usr/bin/env bash
# Local stack runner: ./scripts/dev.sh start|stop|restart|status [api|worker|gateway|web|edge]
# Infra (Postgres, Valkey, Kafka, S3, egress proxy) runs in Docker via `pnpm infra:up`.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
run="$root/.dev"
mkdir -p "$run"
services=(api worker gateway web edge)
[ $# -ge 2 ] && services=("$2")

cmd_for() {
  case "$1" in
    api) echo "cd '$root/apps/api' && OTEL_SERVICE_NAME=autodeploy-api exec node --env-file=../../.env --import tsx --import @autodeploy/telemetry/register src/main.ts" ;;
    worker) echo "cd '$root/apps/worker' && OTEL_SERVICE_NAME=autodeploy-worker exec node --env-file=../../.env --import tsx --import @autodeploy/telemetry/register src/main.ts" ;;
    # SSR runtimes (ADR 0008): on a Mac the gateway is outside Docker, so it reaches
    # containers through a localhost port instead of the internal network.
    gateway) echo "cd '$root/apps/worker' && RUNTIME_REACH=publish RUNTIME_BUNDLES_DIR='$run/runtimes' OTEL_SERVICE_NAME=autodeploy-gateway exec node --env-file=../../.env --import tsx --import @autodeploy/telemetry/register src/gateway.ts" ;;
    web) echo "cd '$root/apps/web' && exec pnpm next dev --port 3000" ;;
    edge) echo "cd '$root/apps/edge' && WRANGLER_SEND_METRICS=false exec npx wrangler dev --local --port 8787" ;;
  esac
}

stop_one() {
  local pidf="$run/$1.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    kill "$(cat "$pidf")" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$(cat "$pidf")" 2>/dev/null || break; sleep 1; done
    kill -9 "$(cat "$pidf")" 2>/dev/null || true
    echo "stopped $1"
  fi
  rm -f "$pidf"
}

start_one() {
  stop_one "$1"
  nohup bash -c "$(cmd_for "$1")" >"$run/$1.log" 2>&1 &
  echo $! >"$run/$1.pid"
  echo "started $1 (pid $!, log .dev/$1.log)"
}

case "${1:-}" in
  start) for s in "${services[@]}"; do start_one "$s"; done ;;
  stop) for s in "${services[@]}"; do stop_one "$s"; done ;;
  restart) for s in "${services[@]}"; do stop_one "$s"; start_one "$s"; done ;;
  status)
    for s in "${services[@]}"; do
      if [ -f "$run/$s.pid" ] && kill -0 "$(cat "$run/$s.pid")" 2>/dev/null; then echo "$s: running ($(cat "$run/$s.pid"))"; else echo "$s: stopped"; fi
    done
    ;;
  *) echo "usage: $0 start|stop|restart|status [api|worker|web|edge]"; exit 1 ;;
esac
