#!/usr/bin/env bash
# Ships the committed code to the VM and (re)deploys it. Run from your Mac.
#
#   First time (VM just created):   ./ship.sh ubuntu@<vm public ip>
#     needs, only for that run:     terraform apply -var bootstrap_ssh_cidr=<your ip>/32
#   Every time after:               ./ship.sh autodeploy-vm      (SSH over the tunnel)
#   On a 1 OCPU / 6 GB VM:          SMALL=1 ./ship.sh …          (docker-compose.small.yml)
#
# Idempotent: each step checks before it acts. Only committed files are sent
# (git archive), so local env files and keys never leave the Mac except
# .env.prod, which goes to the VM with mode 600.
set -euo pipefail
target=${1:?usage: ship.sh <ssh target>}
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
envfile="$here/.env.prod"
[ -f "$envfile" ] || { echo "missing $envfile" >&2; exit 1; }
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no -- apps packages infra/deploy infra/sandbox)" ]; then
  echo "Uncommitted changes in apps/packages/infra; ship deploys HEAD only. Commit first." >&2
  exit 1
fi
tag=$(git -C "$root" rev-parse --short=12 HEAD)
owner=$(grep '^GHCR_OWNER=' "$envfile" | cut -d= -f2)
domain=$(grep '^PLATFORM_DOMAIN=' "$envfile" | cut -d= -f2)
dir=/opt/autodeploy
remote() { ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "$target" "$@"; }
step() { printf '\n▸ %s\n' "$*"; }

step "waiting for first-boot setup (Docker + gVisor)"
remote 'cloud-init status --wait >/dev/null 2>&1 || true; command -v docker >/dev/null && sudo docker info --format "{{.Runtimes}}" | grep -q runsc' ||
  { echo "Docker/gVisor missing: check 'sudo cat /var/log/cloud-init-output.log' on the VM" >&2; exit 1; }

step "SSH: keys only, no root"
remote 'sudo tee /etc/ssh/sshd_config.d/99-autodeploy.conf >/dev/null <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd'

step "Cloudflare Tunnel connector (systemd)"
if remote 'systemctl is-active --quiet cloudflared'; then
  echo "already running"
else
  remote 'curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb && sudo dpkg -i /tmp/cloudflared.deb >/dev/null'
  # The token is piped, never put on a command line or in shell history.
  grep '^CLOUDFLARE_TUNNEL_TOKEN=' "$envfile" | cut -d= -f2- | tr -d '\n' |
    remote 'sudo cloudflared service install "$(cat)" >/dev/null 2>&1 && systemctl is-active cloudflared'
fi

step "tools: age (backups), unattended security updates"
remote 'command -v age >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age unattended-upgrades >/dev/null; }'

step "source @ $tag"
git -C "$root" archive --format=tar HEAD |
  remote "sudo rm -rf $dir/src.new && sudo mkdir -p $dir/src.new && sudo tar -x -C $dir/src.new && sudo rm -rf $dir/src && sudo mv $dir/src.new $dir/src"

step ".env.prod (mode 600)"
gid=$(remote "getent group docker | cut -d: -f3")
sed -e "s/^DOCKER_GID=.*/DOCKER_GID=$gid/" -e "s/^IMAGE_TAG=.*/IMAGE_TAG=$tag/" "$envfile" |
  remote "sudo install -m 600 /dev/stdin $dir/src/infra/deploy/.env.prod"

step "sandbox images (first run only; ~10 min)"
remote "sudo docker image inspect autodeploy-build:node24 autodeploy-validator:latest >/dev/null 2>&1 || sudo bash $dir/src/infra/sandbox/build-images.sh"

step "app images @ $tag (built on the VM; no registry needed)"
remote "cd $dir/src && \
  sudo docker build -q -f apps/api/Dockerfile -t ghcr.io/$owner/autodeploy-api:$tag . && \
  sudo docker build -q -f apps/worker/Dockerfile -t ghcr.io/$owner/autodeploy-worker:$tag . && \
  sudo docker build -q -t ghcr.io/$owner/autodeploy-egress:$tag infra/sandbox/egress"

step "deploy (rolling)"
remote "cd $dir/src/infra/deploy && sudo IMAGE_TAG=$tag SKIP_PULL=1 SMALL=${SMALL:-} bash deploy.sh"

step "nightly encrypted backup (03:30 UTC)"
remote "echo '30 3 * * * root bash $dir/src/infra/backup/backup.sh >> /var/log/autodeploy-backup.log 2>&1' | sudo tee /etc/cron.d/autodeploy-backup >/dev/null"

step "health through Cloudflare"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 10 "https://api.$domain/healthz"; then echo; break; fi
  sleep 5
done

step "prune images older than the last 3 deploys"
remote "sudo docker image prune -f >/dev/null; for r in api worker egress; do sudo docker images ghcr.io/$owner/autodeploy-\$r --format '{{.Tag}}' | tail -n +4 | xargs -r -I{} sudo docker rmi ghcr.io/$owner/autodeploy-\$r:{} >/dev/null 2>&1 || true; done"

echo
echo "✓ shipped $tag to $domain"
if [[ "$target" == *@[0-9]* ]]; then
  echo "Next: close the bootstrap SSH rule:  (cd infra/terraform && terraform apply)"
  echo "      then use:  ./ship.sh autodeploy-vm"
fi
