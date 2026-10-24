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

## Amendment, 2026-10-19: any Node server, not only Next.js

The Next.js-only scope above was narrower than what was asked for (server-rendered
apps in general) and wasn't called out at the time. The runtime now takes a
server spec per deployment instead of assuming `node server.js`:

| Bundle | Used for | Start command (in the bundle) |
|---|---|---|
| `next-standalone` | Next.js | `node server.js` (unchanged) |
| `output-dir` | Nuxt, SolidStart (Nitro's self-contained `.output/`) | `node server/index.mjs` |
| `project` | SvelteKit (adapter-node), Astro (@astrojs/node), Remix, React Router, Vite SSR, any Node server | the framework's server, or the app's `start` script |

A `project` bundle is the built checkout with its `node_modules` (caches and
`.git` left out), started in the project's root directory with its binaries on
`PATH`, `PORT`/`HOST`/`HOSTNAME` set, read-only, as before. Static files the
framework emits (`build/client`, `dist/client`, `.output/public`) are served
from the edge. Bundles are capped (`RUNTIME_BUNDLE_MAX_MB`, 300 MB compressed)
because free storage is 10 GB in all. Apps without a usable server (SvelteKit
with adapter-auto, Astro without an adapter, Vite SSR without a start script)
get a message naming the one change that makes them deployable.


## Amendment, 2026-10-24: wake only into memory the VM has

"20 awake" was arithmetic, never measured, and at full caps it doesn't fit:
the platform's services (~6.5 GB of limits) plus a build and its check (4 GB)
plus 20 × 256 MB come to ~15.5 GB on a 12 GB VM. Out of memory, Linux kills a
process, possibly Postgres, and every site and the API go down with it.

So the VM's own available memory (`MemAvailable`) now decides too. A server
wakes only if, less what wakes still starting may take, `RUNTIME_MIN_FREE_MB`
(4 GB: a build's 3 GB plus 1 GB) stays free; otherwise the longest-idle servers
sleep first, and with none idle the visitor gets a 503 "try again shortly". Wake
decisions are made one at a time, so a burst can't all count the same memory.
Every 30 s, if free memory has fallen below half the reserve anyway (a build
started, servers grew into their caps), idle servers sleep until it hasn't.
`RUNTIME_MAX_AWAKE` (20) stays as an upper bound. The real number is for the
capacity test on the VM to find.

## Amendment, 2026-10-24 (later): measured, then made faster and tidier

The capacity test (20 real sites, report `AutoDeploy-capacity-test-2026-10-24.docx`)
found 20 awake used ~1.1 GiB, CPU (not memory) limits busy sites, and three
problems, fixed here:

- **Slow first wakes.** Next.js took 4.4-7.8 s against the 1-3 s expected
  above; a re-wake with the bundle already on disk took 3.7 s against 7.8 s. So
  the build now leaves each new bundle unpacked where the gateway looks (the
  worker mounts the same directory), and the gateway asks every 100 ms whether
  a server is ready (was ~400 ms). The "runtime started" log line now says
  where the time went: `bundleMs`, `runMs`, `readyMs`, `bundleCached`. The rest
  of a Next.js wake is Next.js starting on 0.5 CPU.
- **Unpacked bundles were never deleted** (67, 2.5 GB on the VM that day).
  Every hour the gateway deletes those not running, not a project's live
  deployment, and unused for `RUNTIME_BUNDLE_KEEP_H` (24) hours; they stay in
  object storage, so a later wake fetches them again.
- **A deleted project's awake site kept running** until idle, and its stop then
  failed (its database record gone), one site per 30-second pass. Each pass now
  stops at once any site whose deployment is gone or no longer served, and a
  stop that can't be recorded for a deleted deployment isn't an error.

## Amendment, 2026-10-24 (evening): a CPU split, after measuring

With 20 sites busy, the platform stayed fast on CPU weights alone (API median
55 ms at 100% CPU) but a build starved: 71 s alone, 676 s under load, so a
3-minute build would have hit the 15-minute limit. Now, by systemd slices that
`ship.sh` creates from the VM's CPU count:

- `autodeploy.slice` (sites and builds together): at most 90% of the CPUs, so
  the platform and the VM itself always keep 10%;
- `autodeploy-sites.slice` inside it: at most 75%, so a build always keeps
  some; `autodeploy-builds.slice` (builds and site checks): weight 50.

Inside them the weights still apply (sites 512, builds 256). The gateway,
builds and site checks pass `--cgroup-parent`; if Docker refuses (exit 125)
they start without it and log a warning, so the split can't stop a site or a
build. Each deploy starts one gVisor container in the sites slice and says in
its log whether it landed there.
