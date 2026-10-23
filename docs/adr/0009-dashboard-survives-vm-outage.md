# ADR 0009: The dashboard stays up when the VM is down

Status: accepted (2026-10-23)

## Context

Every request to `app.autodeploy.fyi` went Cloudflare → tunnel → Caddy on the
VM, which fetched pages from Vercel and passed `/api` and `/auth` to the API.
That kept one origin (first-party cookies, no CORS) and the visitor's real
address (`CF-Connecting-IP`), and spent none of the edge Worker's free quota.
But when the VM was down, the landing page and the dashboard were down too:
visitors got a Cloudflare error page. Static user sites kept working (Worker +
KV + B2); server-rendered ones, which run on the VM, did not. Pushes made
during an outage were lost, because GitHub delivers each webhook once.

Options for reaching the API once pages come straight from Vercel:

| Option | Verdict |
|---|---|
| Vercel rewrites `/api` to the API | One origin, but the API sees Vercel's address. Per-visitor limits need a secret header from Vercel, and a leaked secret lets anyone choose their address. Every call and log stream counts toward Vercel's free limits; going over pauses the dashboard. |
| **The browser calls `api.<domain>` directly** | Cloudflare still names the visitor; live logs skip Vercel; Vercel serves only cached pages. Costs: CORS (already set up for the app's origin), a preflight before writes (cached 2 h), and the session cookie moving to the API's host. |

## Decision

- The dashboard calls the API at its own address (`AUTODEPLOY_API_ORIGIN`,
  set from `API_ORIGIN` or Vercel's build). Local development keeps
  same-origin rewrites.
- The session cookie stays host-only (`__Host-`), now on `api.<domain>`.
  Sign-in callbacks (GitHub, later Google) land there.
- **Nobody signs in again:** on its first 401 the dashboard trades the old
  host's cookie for a one-time pass (`/auth/session/handoff`, the only path
  Vercel still proxies) and gives it to the API (`/auth/session/claim`), which
  sets the same session's cookie on its own host. The pass lasts 60 s, works
  once, and only the dashboard's origin may ask. Remove after 2026-11-10.
- **Outages are stated, not shown as errors:** API calls that get no answer,
  or a non-JSON 5xx from Cloudflare or Caddy, mark the API down. A banner
  explains what still works, every button and field is disabled (a disabled
  `<fieldset>`), and the API's `/readyz` is checked every 10 s until it answers;
  then everything reloads. While up it is checked every minute.
- **Missed pushes are caught up:** the worker asks GitHub for webhook
  deliveries that failed in the last 72 h and resends only the newest per
  branch, pull request or installation, and only while it is still current
  (the branch head, the PR head). An outage costs one deploy per branch, never
  a stale one.
- `app.<domain>` points at Vercel directly (DNS only), after the release that
  moves sessions.

## Consequences

- With the VM down: the landing page and dashboard load; sign-in, deploys and
  changes are paused with a clear message; static sites stay online;
  server-rendered sites and live data come back with the VM.
- Dashboard pages lose Cloudflare in front of them (Vercel's own protection
  applies). The API keeps Cloudflare.
- Builds cut off by an outage already restart by themselves (lease reaper),
  count as one deploy, and don't charge the lost attempt's minutes.
