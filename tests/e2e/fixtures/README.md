# End-to-end fixtures

Small real apps that `tests/e2e/prod-smoke.spec.ts` imports into a running
AutoDeploy (by repository URL plus root directory) and checks live:

- `static-vite`: a Vite build served from the edge.
- `ssr-next`: server-rendered Next.js; a page rendered per request, a POST
  API route, and outbound requests (public allowed, cloud metadata refused).
- `needs-env`: fails until `E2E_GREETING` is set, to exercise the
  failure → environment variable → deploy again path.

Each prints a marker the test looks for. Lockfiles are committed so installs
are reproducible.
