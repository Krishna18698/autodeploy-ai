# Issues to fix

What's left and what's done, kept current. Last updated 2026-10-23 (late).

## Not done, needed before launch

The owner's order: finish the product first; the last three steps below come
last, each only on the owner's yes.

- [ ] **A sites domain of our own on the Public Suffix List** (audit 2026-10-22, finding #1). User sites live on `autodeploy.dpdns.org`, apart from the dashboard (dpdns.org is on the list, so browsers and Safe Browsing treat it separately from autodeploy.fyi). But every user site shares that one entry, so one site can set cookies for another and one phishing site can get every user site flagged. Vercel's fix: `vercel.app` is itself on the list. Ours: buy a sites domain for 2+ years (the list requires it; free dpdns renews yearly) and submit it; approval takes weeks, browsers pick it up over months.
- [ ] **Open sign-ups:** remove `ALLOWED_GITHUB_LOGINS` from `.env.prod` and ship. Ready: per-account limits, email sign-in with verification and reset, two-step sign-in, legal pages.
- [ ] **Make the GitHub App public** (app settings → Advanced) so other people can install it on their own accounts.
- [ ] **Make the repository public.**

## Not done

**To build (nice to have, not blocking launch)**
- [ ] **Google sign-in.** Needs a Google OAuth client from the owner, with the redirect `https://api.autodeploy.fyi/auth/google/callback`; then a "Continue with Google" button.
- [ ] **Different variable values for previews:** environment variables are per project today, so production and pull-request previews get the same values.
- [ ] **Variables from the command line:** an `autodeploy env` command in the CLI.
- [ ] **Audit #21:** the AI repair still fails the JSON trailing-comma case (the model repeats an ambiguous snippet). A `line` field in the edit schema broke NVIDIA's structured output (7/8 → 1/8 in an A/B), so never re-add it untested.
- [ ] **Status lights:** the pulsing current pipeline step, the "live" dot on build logs and an app "waking up" still pulse the old way; the owner may want a design for them.
- [ ] **Projects table on load:** column headers can shift a few pixels sideways as real names replace the placeholders (nothing moves up or down).
- [ ] **Deploys can fail on a dropped tunnel connection:** on 2026-10-23 the connection from GitHub's runner to the VM (Cloudflare Access SSH) broke mid-deploy three times ("Broken pipe", exit 255), at random steps, with the VM healthy. Nothing was half-installed (it breaks before the containers change) and re-running the failed job worked each time (`gh run rerun <id> --failed`). Option: have `infra/deploy/ship.sh` retry a step whose connection drops.
- [ ] **Smoke: fetching a just-deployed site sometimes times out from the test machine:** "a failed build is never a dead end" timed out twice (60 s) on its very last step, loading the new site from the Mac, then passed on the third run. Site serving didn't change that day; watch whether it comes back.

**Clean-up with a date**
- [ ] **Remove the session move after 2026-11-10:** `apps/api/src/routes/session-move.ts`, the handoff rewrite in `apps/web/next.config.ts` and `moveSession` in `apps/web/lib/api.ts`. By then every old cookie on the dashboard's host has expired.
- [ ] **Drop `autodeploy.dpdns.org` from `legacy_domains`** once nothing links there (its free registration lapses June 2027).

**Upkeep**
- [ ] **Renew autodeploy.fyi** each October (auto-renew is on in Cloudflare).
- [ ] **Renew the `e2e-smoke` API token** before 2027-01-21 (rotated 2026-10-23 after it was exposed; save the new one with the hidden-input command into `infra/deploy/.e2e-token`).
- [ ] **Renew the deploy's Access service token** before October 2027: `terraform apply -replace=cloudflare_zero_trust_access_service_token.deploy`, then update the two `CF_ACCESS_*` GitHub secrets.

## Done

**2026-10-23**
- [x] **Two-step sign-in asks when it matters, not at every sign-in:** the code is needed on a new browser, after 30 days (14 unused), from another country than that browser's last code, over Tor, or after 3+ wrong passwords; otherwise a trusted browser signs straight in ("Trust this browser for 30 days", ticked by default). Settings shows the trusted browsers with "Forget trusted browsers"; turning two-step off forgets them. Important changes now also include project changes (build settings, environment variables, approving an AI fix); one code covers 10 minutes; deploys and rollbacks don't ask.
- [x] **Saved variable values are shown as dots only** (like Vercel's Sensitive variables): nothing of a value, not even its length; values stay write-only. Migration 0014 replaced the partial previews already stored.
- [x] **Redirect loop for visitors whose DNS still sent the dashboard to Cloudflare** (a VPN's stale cache): the dashboard redirected the edge Worker's fallback requests back to itself, forever. The post-switch cleanup had removed the exception the Worker relies on; restored and checked on production.
- [x] **Environment variables when importing:** the import page lists the variables the analysis finds in the code as fields to fill in, plus "+ Add variable" and "Import .env"; they're saved encrypted with the project, so the first build has them (owners and admins only, as in the Environment tab). The analysis now also finds variables read on the server (`process.env.DATABASE_URL` and the like), not only the public browser prefixes.
- [x] **"Deploy again" after changing a variable:** saving, importing or removing one shows a message that the live site still uses the old values, with Deploy now (wave dots, then the new deployment's page) and ✕ for later.
- [x] **Loading animations:** the logo builds up while the account loads; every page, list and panel shows shimmer placeholders; buttons show an orbit ring, approve and deploy buttons wave dots; screenshots show dots until they arrive. Placeholders take exactly the space of what replaces them, so nothing jumps on load (measured at phone and desktop width). Sign-out goes to the home page.
- [x] **The dashboard stays up when the VM is down** (ADR 0009): `app.autodeploy.fyi` points at Vercel and the browser calls `api.autodeploy.fyi`. An outage shows a banner, pauses buttons and recovers by itself; pushes made during an outage are deployed afterwards (newest per branch, only if still current); sessions moved over without anyone signing in again. Tested on production with the owner.
- [x] **Two-step sign-in** with an authenticator app, recovery codes and a fresh code before dangerous actions.
- [x] **Re-importing an existing project is refused at once** (~1.3 s, was ~16 s): the duplicate is checked before the repository is downloaded and analysed.
- [x] **Page switches sometimes stuttered in the smoke test:** investigated with CPU profiles. The freezes came with the test machine overloaded (even Playwright's own lookups froze); without that load a page switch takes ~0.3 s. If a slow switch shows up on a real device, profile it there.
- [x] **Integration tests sign in from their own test addresses**, so the shared sign-in limit can't make a later file fail.

**2026-10-22 and earlier**
- [x] **Audit 2026-10-22** ([audit-2026-10-22.md](audit-2026-10-22.md)): every finding fixed except #21 (above) and #18 (accepted), including #14 (Cloudflare Access on SSH), #16 (rpcbind off) and #17 (Grafana service account set to Viewer).
- [x] **Admin takedown tool:** find a site by any of its addresses, account or owner; take it down or suspend the account, with the reason emailed and kept in the audit log; every address answers 451 within a minute until restored.
- [x] **Automatic deploys of AutoDeploy itself:** a push to `main` that passes CI ships the VM, the edge and the dashboard and checks they answer. Pause by unsetting the `AUTO_DEPLOY` repository variable. Terraform stays manual.
- [x] **Redesign** (Linear-like dark, Geist, subtle motion) and the **logo** (deploy-history layers).
- [x] **Permanent domain** autodeploy.fyi (Cloudflare Registrar); autodeploy.dpdns.org redirects to it.
- [x] **Per-account limits** (10 projects, 3 server-rendered, 20 deploys a day, 300 build minutes a month, 1 GB, 60 AI calls a day), counted in a ledger deleting a project can't undo.
- [x] **Server-rendered apps beyond Next.js:** Nuxt, SvelteKit, Astro and Node servers pass the production smoke suite.
- [x] **Email:** Resend sends from noreply@autodeploy.fyi; hello@ forwards to the owner; a failure email was received.
- [x] **Monitoring:** Sentry errors arrive and are emailed; Grafana dashboard and 8 alerts email the owner (ServerSilent covers a dead VM).
- [x] **AI repair evidence:** OpenRouter measured (3/4 fixed, 0 false fixes); Cloudflare Workers AI added as a third provider (10/12 fixed, 0 false fixes); 11 evaluation cases; one retry for edits that don't fit and for malformed answers.
- [x] **Sign-in hardening:** installations matched by account id; email accounts can connect GitHub; organisation installations claimed by the owner who installed them; 10 wrong passwords pause password sign-in for that address for 15 minutes.
- [x] **Import variables from a .env file** in a project's Environment tab (2026-10-18).
- [x] **Colour wipe on phones** is a band with the wordmark (2026-10-18).
- [x] "₹0" wording removed; the site says "free".
