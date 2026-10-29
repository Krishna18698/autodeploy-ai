# ADR 0012: Portfolio mode — a read-only demo for everyone, deploys by approval

Status: accepted (2026-10-29); on in production since 2026-10-30

## Context

AutoDeploy is a portfolio project first. The people who look at it (mostly
recruiters and engineers) spend a few minutes: they won't connect GitHub and
deploy a repository, but they do want to see it working.

Open deploys carry the platform's biggest risk. Users' sites share
`autodeploy.dpdns.org`, which isn't on the Public Suffix List
([ADR 0011](0011-cookies-on-the-shared-sites-domain.md)), so blocklists and
Safe Browsing may treat every site as one: a single phishing page can get all
of them flagged. Free hosts with open sign-up are where phishing pages go,
however small the host.

Until now sign-in was limited to an allowlist of GitHub logins, so visitors
couldn't see anything at all.

## Decision

`DEPLOY_APPROVAL=approval` and `DEMO_ORG_NAME` (migration 0020):

- **Anyone can sign in** (GitHub, Google, email) and is added to the demo org
  as a viewer. Someone whose own account can't deploy yet, and has nothing in
  it, opens in the demo. The demo holds real deploys of the repository's own
  test apps (a static site, a server-rendered app, a failure the AI fixes, one
  that needs an environment variable), never the owner's projects.
- **The demo is read-only** by the existing roles: viewers can't change
  anything. In its member list visitors see who runs it and themselves, never
  each other.
- **Deploying needs approval.** An account creates projects and deploys (by
  hand, a push, the CLI or a rollback) only once a platform admin approves it.
  Accounts that existed are approved by the migration. The person asks with a
  short note; the admins are emailed once a day at most, and approve or
  dismiss it from Admin; approval emails the owner.
- The demo org is marked (`orgs.is_demo`, at most one), not found by its slug,
  so no account that took the slug first could become it. It is created at
  start-up, owned by the platform admins.

Unset, both settings keep the previous behaviour: deploying open to every
account, no demo.

## Consequences

- Strangers can't put a site on the shared domain, so the domain-flagging risk
  only comes from accounts the owner chose to approve.
- Visitors see the real product, with real data, without an allowlist.
- The demo needs keeping alive: its sites must stay live and its history
  current. Its builds run on the same VM, within the demo org's own limits.
- Approving is manual. That's the point at this size; a waiting list or
  automatic approval for, say, older GitHub accounts can come later.
