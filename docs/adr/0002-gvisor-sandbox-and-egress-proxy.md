# 2. Untrusted builds run in gVisor with an allowlisting egress proxy

Status: accepted · 2026-09

## Context
`npm install && npm run build` executes arbitrary code (lifecycle scripts,
build plugins). It must not reach the host, other tenants, or the internet at
large, and must not read platform secrets.

## Decision
Each attempt runs in a fresh container: gVisor `runsc` runtime (user-space
kernel), read-only root, tmpfs `/tmp`, all capabilities dropped,
`no-new-privileges`, non-root, CPU/memory/PID limits, a wall-clock timeout.
The container joins an `internal` Docker network with no route out; the only
exit is a small HTTP(S) proxy that tunnels to an allowlist (npm/yarn
registries, GitHub codeload). Project env vars are decrypted only for the
build and redacted from logs.

## Alternatives
- Firecracker: needs KVM, which free VMs don't expose.
- Hosted sandboxes (E2B, Modal, Cloudflare Containers): credits or paid plans.
- GitHub Actions in our own repo: likely against GitHub's Actions terms for
  third-party code; kept only as an executor that runs in the *user's* repo.

## Consequences
The worker holds the Docker socket (root-equivalent), so it never executes
user code itself. gVisor is unavailable on macOS; local development uses runc
with the same flags.
