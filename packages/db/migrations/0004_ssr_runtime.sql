-- Server-rendered (SSR) apps run as on-demand containers (ADR 0008).

-- Which kind of site a deployment is, and for SSR the runtime bundle
-- (runtimes/<sha>.tar.gz in object storage) the gateway starts.
alter table deployments
  add column mode text not null default 'static' check (mode in ('static', 'ssr')),
  add column runtime_sha text,
  add column runtime_node smallint;

-- What the gateway is running right now; the dashboard reads it.
create table runtime_instances (
  deployment_id   uuid primary key references deployments(id) on delete cascade,
  org_id          uuid not null references orgs(id) on delete cascade,
  status          text not null check (status in ('starting', 'running', 'stopped', 'failed')),
  container       text,
  started_at      timestamptz,
  last_request_at timestamptz,
  cold_start_ms   integer,
  requests        bigint not null default 0,
  error           text,
  updated_at      timestamptz not null default now()
);
create index runtime_instances_status_idx on runtime_instances (status);

alter table runtime_instances enable row level security;
create policy tenant_isolation on runtime_instances to app_user
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant select on runtime_instances to app_user;
