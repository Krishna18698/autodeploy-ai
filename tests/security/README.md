# Security scans (OWASP ZAP)

| Target | Scan | Result |
|---|---|---|
| API (`/openapi.json`, local, unauthenticated) | `zap-api-scan.py` (active) | **118 pass, 0 warn, 0 fail** |
| Landing on Vercel (before) | `zap-baseline.py -m 1` (passive) | 59 pass, 8 warn, 0 fail; CSP and Permissions-Policy missing |
| Landing, production build (after) | `zap-baseline.py -m 1` | 63 pass, **4 warn**, 0 fail |

Remaining warnings, accepted:
- `script-src 'unsafe-inline'`: the App Router inlines its bootstrap; nonces
  would make every page dynamic. Everything else is same-origin only.
- Cross-Origin-Embedder-Policy: no cross-origin isolation needed (no
  SharedArrayBuffer); enabling it would only add breakage risk.
- Non-storable content, "modern web application": informational.

**Production, 2026-10-22** (the `zap` workflow, passive: `zap-baseline.py` on
the dashboard, `zap-api-scan.py -S` on the API description): API, informational
only. Dashboard: no high-risk alerts. Medium: `unsafe-inline` (accepted, above);
`Access-Control-Allow-Origin: *` on public pages (landing, legal, robots), which
Vercel adds; browsers send no cookies with it, and account data only comes from
`/api`, whose CORS stays restricted to the dashboard. The rest flag
`/cdn-cgi/…`, Cloudflare's own email-obfuscation script and error styles.

The API scan is unauthenticated, so it covers the public surface; every
authenticated route correctly answered 401. Authorization across roles and
orgs is covered by the integration matrix (0 cross-tenant leaks).

Reproduce (stack running):
```bash
docker run --rm -v "$PWD/tests/security/zap:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py -t http://host.docker.internal:4000/openapi.json -f openapi -r api-report.html
docker run --rm ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t https://<app url>/ -m 1
```
