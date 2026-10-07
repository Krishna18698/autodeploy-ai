# ADR 0008: Server-rendered (SSR) apps as scale-to-zero containers on the VM

Status: accepted (2026-10-07)

## Context

V1 served static sites only (the original blueprint scoped full SSR out of V1).
Most real Next.js apps, including the owner's portfolio, need a server: API
routes (`/api/chat`, `/api/contact`), server actions, per-request rendering.
The platform must stay at ₹0.

Options:

| Option | Verdict |
|---|---|
| Cloudflare Workers via OpenNext | Free plan allows ~10 ms CPU per request and 3 MB scripts; Next.js rendering exceeds both. |
| One always-on container per site | Simple, but 12 GB fits only a few dozen idle Node servers. |
| **Containers on the VM, started on demand, stopped when idle** | Fits the free VM; this is how Fly/Render/Cloud Run behave. |

## Decision

**Scope:** Next.js (App and Pages router) built in `standalone` mode. Other
server frameworks stay unsupported with a clear message.

**Build:** the same sandbox, with `NEXT_PRIVATE_STANDALONE=1` (Next's own switch
for the default `output`), so the user's `next.config` is never edited. The
worker assembles a runtime bundle (`.next/standalone` + `.next/static` +
`public`), stores it content-addressed as `runtimes/<sha256>.tar.gz` in B2, and
also publishes the static assets as a normal artifact.

**Validate:** the validator container (still `--network none`) runs the bundle's
`server.js` itself and loads `/` in Chromium, exactly like a static site.

**Serve:** the edge Worker serves files that exist in the static artifact
(`/_next/static/*`, `public/*`) straight from B2. Everything else (pages, API
routes, any method) is proxied through the tunnel to the **gateway**:

- a service on the VM (worker image, `gateway.js` entrypoint) that only accepts
  requests carrying the internal token;
- on a request for a deployment with no running container, it fetches and
  unpacks the bundle (cached on disk), starts a container, waits for the port,
  then proxies (streaming, so SSE/AI chat responses flow);
- each container: gVisor, read-only root, `--cap-drop ALL`, non-root, 256 MB,
  0.5 CPU, 128 pids, tmpfs for `/tmp` and `.next/cache`, the project's
  decrypted env vars, on an internal network whose only exit is a second egress
  proxy in *public* mode (any public host; private, loopback, link-local and
  metadata addresses refused after DNS resolution: SSRF guard);
- idle for 15 minutes → stopped; at most 20 awake → least recently used stopped
  first; state recorded in `runtime_instances` for the dashboard.

Rollback stays a pointer flip: the previous deployment's bundle is still in B2
and starts on its next request.

## Consequences

- One free VM hosts many SSR sites; ~20 awake at once (≈5 GB for runtimes).
- First request after idle has a cold start (bundle cached on disk: ~1–3 s).
- User code runs persistently, so isolation matters more than for builds; the
  limits above and the SSRF-guarded egress are the boundary.
- Per-org quota: 3 SSR projects.
