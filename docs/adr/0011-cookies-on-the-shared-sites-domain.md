# ADR 0011: Cookies on the sites' shared domain

Status: accepted (2026-10-29)

## Context

Users' sites live at `<slug>.autodeploy.dpdns.org`. `dpdns.org` is on the
Public Suffix List, which keeps them apart from the dashboard
(`autodeploy.fyi`), but `autodeploy.dpdns.org` isn't, so to browsers every
user's site is one site. One of them can:

- set a cookie for all of them (`Domain=autodeploy.dpdns.org`, from its server
  or its scripts): planting a session into another site, or reading one that
  site's server shared with the whole domain;
- post a form to another and have its `SameSite=Lax`/`Strict` cookies sent,
  because the request is same-site;
- evict or flood cookies for the whole domain (browsers cap about 180).

The list is the full fix, and isn't open to us yet: it wants the domain
registered 2+ years ahead (dpdns renews yearly) and declines projects without
thousands of users (a small deploy platform was declined in August 2026).
GitHub, with Pages on `*.github.com` in 2013, defended on the server (dropping
duplicate session cookies on every path, catching escaped names) and moved
because cookie overflow beat that: with only the fake cookie left, nothing told
it apart. `__Host-` cookies, added to browsers since, can't be set from another
host even after an overflow.

## Decision

The SSR gateway applies four rules to every server-rendered site's traffic
(`packages/core/src/site-cookies.ts`, applied in `apps/worker/src/gateway/proxy.ts`):

1. `Domain=` is stripped from cookies the app sets, so they stay its own (as
   the list would force).
2. Cookies scripts can't read (`HttpOnly`) are stored as `__Host-ad_<name>`
   (Path=/, Secure). The app still reads and sets `<name>`; a plain `<name>`
   arriving was planted, or predates this, and is dropped. Deletions remove
   both forms, so signing out works without `HttpOnly` on the deletion.
3. A request marked `Sec-Fetch-Site: same-site` (or, without Fetch Metadata,
   with a sibling's `Origin`) is treated as cross-site: `Strict` cookies are
   withheld, and `Lax` or unset ones unless it's a top-level link (GET
   navigation).
4. Planted copies of the app's cookie names are deleted on every path they
   could hide on (the parent domain's copy; for rule-2 names the host's plain
   one too): always when one was dropped, and on page loads for its other
   names, before the page's scripts run.

The gateway remembers per project which names the app keeps from scripts and
their SameSite (`site_cookies`, at most 32 names), so rules 2 and 3 hold for a
visitor who hasn't got the real cookie yet: the attacker can't slip them a
session. It's the gateway rather than the edge Worker because the memory needs
a database: KV's 1,000 writes and 100,000 reads a day are shared with routing
(the 2026-10-24 outage).

## Consequences

- Visitors signed in to a server-rendered site before this are signed out once
  (their plain cookie can't be told from a planted one). Only the owner's sites
  existed when it shipped.
- An app's cookie set for a path (`Path=/admin`) becomes site-wide when stored
  as `__Host-`; two same-named cookies on different paths would collide.
- Cookies scripts read (CSRF tokens, preferences) keep their names, so a
  planted copy can reach the server on one request before rule 4 deletes it;
  rule 3 still stops a sibling from using one in a forged form.
- Static sites get none of this. They have no server to protect, and deleting
  every cookie on the shared domain would break analytics: Google Analytics
  and others put their cookies on the highest domain they can, which here is
  the shared one. Their own scripts' cookies stay plantable; `__Host-` names
  protect them.
- Still open without the list: eviction and flooding (log out, or lock out
  until cookies are cleared), password managers offering one site's saved
  password on another, and blocklists judging the whole domain.
- Tested in a real browser (`tests/unit/site-cookies-browser.test.ts`, which
  also shows each attack working without the gateway) and through production
  by the smoke suite's `ssr-node` checks.
