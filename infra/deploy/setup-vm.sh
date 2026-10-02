#!/usr/bin/env bash
# One-time setup for a fresh Oracle Linux / Ubuntu arm64 VM (run as root).
# Installs Docker + gVisor, locks down the host, prepares directories.
set -euo pipefail

# Docker Engine
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# gVisor (runsc): build containers get a user-space kernel instead of the host's.
ARCH=$(uname -m)
URL=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}
for f in runsc containerd-shim-runsc-v1; do
  curl -fsSL "${URL}/${f}" -o "/usr/local/bin/${f}"
  curl -fsSL "${URL}/${f}.sha512" -o "/tmp/${f}.sha512"
  (cd /usr/local/bin && sha512sum -c "/tmp/${f}.sha512")
  chmod a+rx "/usr/local/bin/${f}"
done
/usr/local/bin/runsc install
systemctl restart docker
docker run --rm --runtime=runsc hello-world >/dev/null && echo "gVisor OK"

# Directories (same path inside the worker container and on the host)
mkdir -p /var/lib/autodeploy/work
chown 1000:1000 /var/lib/autodeploy/work

# No inbound ports at all: the Cloudflare Tunnel dials out.
if command -v ufw >/dev/null; then
  ufw default deny incoming && ufw default allow outgoing && ufw --force enable
fi

# Keep memory use above Oracle's 20 % idle-reclaim threshold is natural for this
# stack (Postgres + Kafka + Valkey resident); nothing to tune here.
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)"
echo "Now: build sandbox images (infra/sandbox/build-images.sh), create .env.prod, run deploy.sh"
