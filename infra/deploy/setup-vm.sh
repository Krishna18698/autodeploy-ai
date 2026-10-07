#!/usr/bin/env bash
# One-time setup for a fresh Oracle Linux / Ubuntu arm64 VM (run as root).
# Installs Docker + gVisor, locks down the host, prepares directories.
set -euo pipefail

# Docker Engine
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# gVisor (runsc): build containers get a user-space kernel instead of the host's.
# From gVisor's signed apt repository (the old direct-download URLs now 404).
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq runsc
fi
runsc install
systemctl restart docker
docker run --rm --runtime=runsc hello-world >/dev/null && echo "gVisor OK"

# Directories (same path inside the worker container and on the host)
mkdir -p /var/lib/autodeploy/work /var/lib/autodeploy/runtimes
chown 1000:1000 /var/lib/autodeploy/work /var/lib/autodeploy/runtimes

# No inbound ports at all: the Cloudflare Tunnel dials out.
# The OCI security list is the real gate (no ingress except a temporary
# bootstrap rule); the host firewall must still allow SSH or enabling it would
# cut off that bootstrap session.
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw default deny incoming && ufw default allow outgoing && ufw --force enable
fi

# Keep memory use above Oracle's 20 % idle-reclaim threshold is natural for this
# stack (Postgres + Kafka + Valkey resident); nothing to tune here.
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)"
echo "Now: build sandbox images (infra/sandbox/build-images.sh), create .env.prod, run deploy.sh"
