-- The cookie names each server-rendered project's app sets, as the gateway
-- has seen them (packages/core/src/site-cookies.ts). "protect": scripts can't
-- read it (HttpOnly), so browsers keep it as __Host-ad_<name> and a plain
-- <name> arriving is dropped as planted by another site on the shared domain,
-- even for a visitor who hasn't got the real one yet.
create table site_cookies (
  project_id uuid not null references projects(id) on delete cascade,
  org_id     uuid not null references orgs(id) on delete cascade,
  name       text not null check (length(name) between 1 and 128),
  protect    boolean not null,
  same_site  text check (same_site in ('strict', 'lax', 'none')),
  updated_at timestamptz not null default now(),
  primary key (project_id, name)
);

alter table site_cookies enable row level security;
create policy tenant_isolation on site_cookies to app_user
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
