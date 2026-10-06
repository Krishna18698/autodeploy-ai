# Runbook: deploy

Everything ships with one command from a Mac: `infra/deploy/ship.sh`. It sends
the committed tree (`git archive HEAD`), builds the images on the VM (no
registry, so GHCR's 500 MB private limit never matters), and runs the rolling
`deploy.sh`.

## First time (VM just created)

The VM has no inbound ports. SSH normally goes through the Cloudflare Tunnel,
but the tunnel connector is installed by this first run, so open SSH to your
own address only, for this run only:

1. `cd infra/terraform && terraform apply -var bootstrap_ssh_cidr=$(curl -s https://api.ipify.org)/32`
   (also creates the `ssh.` record and the api/ssh Worker bypass routes).
2. `infra/deploy/ship.sh ubuntu@$(terraform output -raw vm_public_ip)`
   - waits for first-boot setup (Docker + gVisor), hardens sshd, installs
     cloudflared as a systemd service, builds sandbox images (~10 min once),
     builds app images, deploys, installs the nightly backup cron, and checks
     `https://api.<domain>/healthz`.
3. `cd infra/terraform && terraform apply` — closes the SSH rule again.

## Every deploy after

`infra/deploy/ship.sh autodeploy-vm` (the `~/.ssh/config` alias goes through
`cloudflared access ssh`).

- api-1 restarts first and applies migrations under an advisory lock.
- Caddy health-checks `/readyz`, so traffic only reaches ready replicas.
- The worker drains: no new claims, 20 s for in-flight builds, then leases
  are released so the next worker picks the jobs up immediately.

Verify: `curl https://api.<domain>/readyz`, the Grafana ops dashboard, and one
deploy through the dashboard.

Rollback of the platform itself: `git checkout <previous sha>` and ship again
(the last three image tags stay on the VM). Migrations are additive; never edit
an applied migration (the migrator refuses a changed checksum).
