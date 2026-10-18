# End-to-end fixtures

Small real apps that `tests/e2e/prod-smoke.spec.ts` imports into a running
AutoDeploy (by repository URL plus root directory) and checks live:

- `static-vite`: a Vite build served from the edge.
- `static-pnpm`: pins `pnpm@10.21.0`, a version the build image doesn't bake
  in, so corepack has to fetch it during the build.
- `ssr-next`: server-rendered Next.js; a page rendered per request, a POST
  API route, and outbound requests (public allowed, cloud metadata refused).
- `ai-ts-error`: a real TypeScript type error; with AI keys configured,
  `E2E_AI=1` checks the AI proposes a patch, it is approved, and the site goes live.
- `ssr-node`, `ssr-sveltekit`, `ssr-astro`, `ssr-nuxt`: server-rendered apps
  beyond Next.js, each started by its own command (a plain Node server, SvelteKit
  with adapter-node, Astro with @astrojs/node, Nuxt's .output). The last three
  run with `E2E_FRAMEWORKS=1`. `pnpm tsx tests/e2e/run-server-fixture.ts <dir>`
  analyzes a built fixture and starts it the way the runtime does, without Docker.
- `needs-env`: fails until `E2E_GREETING` is set, to exercise the
  failure → environment variable → deploy again path.

Each prints a marker the test looks for. Lockfiles are committed so installs
are reproducible.
