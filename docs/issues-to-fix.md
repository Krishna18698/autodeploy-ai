# Issues to fix

Small things noticed while using the product; newest last.

- [x] **Colour wipe looks empty on phones.** Fixed 2026-10-18: a band with the wordmark on phones. Between the story and the numbers
  the landing page shows a full-screen cyan panel with the logo (the transition
  from the Relay reference). It works as a quick sweep on desktop, but on a
  phone it reads as a large empty block. Proposed: a thin band with the logo on
  small screens, full sweep on desktop. (`apps/web/components/landing/sections/Wipe.tsx`)
- [x] **Import env keys from a .env file**, or add them by hand. Done 2026-10-18: Environment → Import .env (paste or choose a file; keys previewed, bad lines reported, saved in one transaction).

## Before public

Status on 2026-10-22. The owner's order: finish the product first; opening
sign-ups, making the GitHub App public and making the repository public are
the last steps.

**Last steps (each needs the owner's yes)**
- [ ] **Open sign-ups:** remove `ALLOWED_GITHUB_LOGINS` from `.env.prod` and ship.
  Ready: per-account limits, email sign-in with verification and reset, legal pages.
- [ ] **Make the GitHub App public** (app settings → Advanced) so other people can
  install it on their own accounts.
- [ ] **Make the repository public.**

**Still to build**
- [ ] **Google sign-in** (the owner provides a Google OAuth client).
- [x] **Redesign** shipped 2026-10-22: Linear-like dark, Geist, subtle motion.
- [ ] **Automatic deploys of AutoDeploy itself on push** (GitHub Actions: lint and
  tests, then ship, edge and dashboard), or keep a manual yes per deploy. Needs
  three deploy credentials stored as GitHub secrets; the VM keeps its own `.env.prod`.

**Upkeep**
- [x] **Permanent domain:** autodeploy.fyi (Cloudflare Registrar, bought 2026-10-21). autodeploy.dpdns.org redirects to it; drop it from `legacy_domains` once nothing links there (its free registration lapses June 2027). The eu.org application is no longer needed.
- [ ] **Renew autodeploy.fyi** each October (auto-renew on in Cloudflare).
- [ ] Confirm a real error shows up in Sentry (only the key-check test event so far).
- [ ] Optional: set the Grafana service account back to Viewer.

**Done since 2026-10-19**
- [x] Per-account limits (10 projects, 3 server-rendered, 20 deploys/day, 300 build
  minutes/month, 1 GB, 60 AI calls/day), counted in a ledger deleting a project can't undo.
- [x] "₹0" wording removed; the site says "free".
- [x] Server-rendered apps beyond Next.js: Nuxt, SvelteKit, Astro and Node servers
  pass the production smoke suite.
- [x] Email to anyone: Resend sends from noreply@autodeploy.fyi; hello@ forwards to the owner.
- [x] Notification email set and a failure email received.
- [x] Grafana dashboard and 8 alerts installed, emailing the owner (ServerSilent
  covers a dead VM, so UptimeRobot was dropped).

**Evidence**
- [x] OpenRouter measured on 2026-10-21 (3/4 fixed, 2/2 escalated, 0 false fixes).
- [x] **AI fallback on a different provider** (2026-10-22): Cloudflare Workers AI (GPT-OSS 120B on Cloudflare's hardware) is the third repair provider, after NVIDIA and OpenRouter (both serve NVIDIA's Nemotron). Measured 10/12 fixed, 6/6 escalated, 0 false fixes over 3 runs, then 7/8, 3/3, 0 on the widened set. Workers AI needed the bare schema and parsed answers handled.
- [x] **Wider AI evaluation** (2026-10-22): 5 realistic cases in `tests/ai-eval/cases.ts` (11 in all). They exposed a false fix (an outage hidden with try/catch) and a blind spot (a JSON file only the build script names); the context now includes files a failing script reads, and the rules forbid hiding outside failures.
- [ ] **Non-unique edits get no second try:** on the JSON case the model picked text that occurs twice, which is rightly refused. One retry telling the model to quote more of the line would likely fix it.
- [ ] Renew the `e2e-smoke` API token before 2027-01-06.

## Sign-in hardening (later)

- [x] **GitHub App installations are matched by account id** (2026-10-21), and email accounts link GitHub from Settings → Account ("Connect GitHub").
- [x] **GitHub organisation installations** (2026-10-22): the installation webhook records who installed the App (only an organisation's owners can), and that person may use the unclaimed installation; importing a project claims it for their AutoDeploy org, after which nobody else can. Takes effect once the App is public (until then it installs only on the owner's account).
- [x] **Per-account sign-in throttling** (2026-10-22): 10 wrong passwords for one address within 15 minutes pause password sign-in for it from any IP (checked before the scrypt work, the same for unknown addresses); "Forgot password" still works and ends the pause.
- [ ] **Google sign-in** (needs a Google OAuth client from the owner).

