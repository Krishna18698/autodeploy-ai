# Issues to fix

Small things noticed while using the product; newest last.

- [x] **Colour wipe looks empty on phones.** Fixed 2026-10-18: a band with the wordmark on phones. Between the story and the numbers
  the landing page shows a full-screen cyan panel with the logo (the transition
  from the Relay reference). It works as a quick sweep on desktop, but on a
  phone it reads as a large empty block. Proposed: a thin band with the logo on
  small screens, full sweep on desktop. (`apps/web/components/landing/sections/Wipe.tsx`)
- [x] **Import env keys from a .env file**, or add them by hand. Done 2026-10-18: Environment → Import .env (paste or choose a file; keys previewed, bad lines reported, saved in one transaction).

## Audit 2026-10-22

See [audit-2026-10-22.md](audit-2026-10-22.md): 2 × P1, 5 × P2, 11 × P3, 4 × P4, each with evidence and a fix, and a status table. All fixed in code except #14 (Cloudflare Access on SSH), #16 (rpcbind) and #17 (Grafana role), which need the owner, and #18 (accepted).

## Before public

**Site isolation (from the 2026-10-22 audit, finding #1)**
- [ ] **Admin takedown tool:** take a site offline and suspend its account in minutes (today it means editing the database). Needed before opening sign-ups, to act on abuse reports.
- [ ] **A sites domain of our own on the Public Suffix List:** user sites now live on `autodeploy.dpdns.org`, separate from the dashboard (dpdns.org is on the list, so browsers and Safe Browsing treat it apart from autodeploy.fyi). But all user sites share that one entry, so one site can set cookies for another and one phishing site can get every user site flagged. Vercel's fix: `vercel.app` is itself on the list. Ours: buy a sites domain for 2+ years (the list requires it; free dpdns renews yearly) and submit it; approval takes weeks, browsers pick it up over months.

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
- [ ] Set the Grafana service account back to Viewer (audit #17).

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
- [x] **One retry for edits that don't fit, and for malformed answers** (2026-10-22): the model is told why its edit didn't apply (text missing or found twice), and an answer that isn't valid JSON is asked for again. Unit-tested; on the real eval the JSON trailing-comma case still fails (the model repeats the same ambiguous snippet), so it stays 7/8.
- [ ] Renew the `e2e-smoke` API token before 2027-01-06.

## Sign-in hardening (later)

- [x] **GitHub App installations are matched by account id** (2026-10-21), and email accounts link GitHub from Settings → Account ("Connect GitHub").
- [x] **GitHub organisation installations** (2026-10-22): the installation webhook records who installed the App (only an organisation's owners can), and that person may use the unclaimed installation; importing a project claims it for their AutoDeploy org, after which nobody else can. Takes effect once the App is public (until then it installs only on the owner's account).
- [x] **Per-account sign-in throttling** (2026-10-22): 10 wrong passwords for one address within 15 minutes pause password sign-in for it from any IP (checked before the scrypt work, the same for unknown addresses); "Forgot password" still works and ends the pause.
- [ ] **Google sign-in** (needs a Google OAuth client from the owner).

