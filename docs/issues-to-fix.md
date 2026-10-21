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
- [ ] **Redesign** (branch `redesign`): ship once the owner approves it.
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
- [ ] **AI fallback shares the primary's model** (Nemotron 3 Ultra on both). It covers NVIDIA rate limits but not the model being withdrawn again; no non-NVIDIA free model on OpenRouter passed the eval (Cohere North Mini Code, MiniMax M3.1 Flash gave invalid output). Re-check monthly with the eval.
- [ ] Widen the AI evaluation beyond the corpus's 6 AI cases with realistic failures.
- [ ] Renew the `e2e-smoke` API token before 2027-01-06.

## Sign-in hardening (later)

- [x] **GitHub App installations are matched by account id** (2026-10-21), and email accounts link GitHub from Settings → Account ("Connect GitHub").
- [ ] **GitHub organisation installations**: an installation on an organisation (not a person) is only usable once some project of the org claims it, and nothing can claim it first. Needs a setup URL that checks the installer is an org admin (GitHub's user-to-server `GET /user/installations`).
- [ ] **Per-account sign-in throttling.** Password sign-in is limited per IP (10/min) and costs ~50 ms of scrypt per try; add a per-address failure counter to slow down guessing spread across many IPs.
- [ ] **Google sign-in** (needs a Google OAuth client from the owner).

