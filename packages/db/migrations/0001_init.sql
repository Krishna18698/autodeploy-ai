-- AutoDeploy schema v1.
-- Conventions: uuid ids for anything exposed in the API (no enumeration),
-- bigint identity for internal append-only streams (jobs, events, outbox).

create extension if not exists pgcrypto;

-- Role the API assumes inside tenant transactions. It has no BYPASSRLS, so
-- row-level security applies even if a query forgets its org filter.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

-- ---------------------------------------------------------------- identity
create table users (
  id          uuid primary key default gen_random_uuid(),
  github_id   bigint unique,
  login       text not null unique,
  name        text,
  email       text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create table orgs (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  name               text not null,
  daily_deploy_quota int  not null default 50 check (daily_deploy_quota >= 0),
  created_at         timestamptz not null default now()
);

create table memberships (
  org_id     uuid not null references orgs(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on memberships(user_id);

create table sessions (
  token_hash    text primary key,           -- sha256 of the cookie value
  user_id       uuid not null references users(id) on delete cascade,
  org_id        uuid references orgs(id) on delete set null,
  csrf_token    text not null,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index sessions_user_idx on sessions(user_id);
create index sessions_expiry_idx on sessions(expires_at);

create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  prefix        text not null,
  scopes        text[] not null,
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table github_installations (
  id             bigint primary key,
  org_id         uuid references orgs(id) on delete set null,
  account_login  text not null,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- projects
create table projects (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references orgs(id) on delete cascade,
  slug                  text not null unique,
  name                  text not null,
  repo_full_name        text not null,
  repo_url              text not null,
  installation_id       bigint references github_installations(id) on delete set null,
  default_branch        text not null default 'main',
  framework             text not null default 'unknown',
  root_dir              text not null default '.',
  node_version          int,
  install_command       text,
  build_command         text,
  output_dir            text,
  executor              text not null default 'sandbox' check (executor in ('sandbox', 'github_actions')),
  analysis              jsonb,
  active_deployment_id  uuid,
  next_deploy_number    int not null default 1,
  version               int not null default 1,   -- optimistic concurrency
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, repo_full_name, root_dir)
);
create index projects_org_idx on projects(org_id);

create table env_vars (
  project_id      uuid not null references projects(id) on delete cascade,
  org_id          uuid not null references orgs(id) on delete cascade,
  key             text not null,
  ciphertext      bytea not null,   -- AES-256-GCM(iv || tag || data) under a per-value DEK
  dek_ciphertext  bytea not null,   -- DEK wrapped by the master key
  key_version     int not null,
  preview         text not null,    -- e.g. "sk-…a1b2"; never the value
  updated_at      timestamptz not null default now(),
  primary key (project_id, key)
);

-- ------------------------------------------------------------- deployments
create table artifacts (
  id              uuid primary key default gen_random_uuid(),
  sha256          text not null unique,     -- content address of the whole site
  storage_prefix  text not null,
  file_count      int not null,
  bytes           bigint not null,
  created_at      timestamptz not null default now()
);

create table deployments (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references orgs(id) on delete cascade,
  project_id            uuid not null references projects(id) on delete cascade,
  number                int not null,
  status                text not null default 'CREATED',
  kind                  text not null default 'production' check (kind in ('production', 'preview')),
  trigger               text not null check (trigger in ('manual', 'push', 'pull_request', 'redeploy', 'cli')),
  ref                   text,
  branch                text,
  commit_sha            text,
  commit_message        text,
  pr_number             int,
  build_config          jsonb,
  artifact_id           uuid references artifacts(id),
  screenshot_key        text,
  error_summary         text,
  recovered_by          text check (recovered_by in ('rule', 'ai')),
  idempotency_key       text,
  created_by            uuid references users(id) on delete set null,
  queued_at             timestamptz,
  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (project_id, number)
);
create index deployments_project_idx on deployments(project_id, created_at desc);
create index deployments_org_status_idx on deployments(org_id, status);
create index deployments_org_created_idx on deployments(org_id, created_at desc);

alter table projects
  add constraint projects_active_deployment_fk
  foreign key (active_deployment_id) references deployments(id) on delete set null
  deferrable initially deferred;

create table deployment_attempts (
  id               uuid primary key default gen_random_uuid(),
  deployment_id    uuid not null references deployments(id) on delete cascade,
  org_id           uuid not null references orgs(id) on delete cascade,
  attempt_no       int not null,
  executor         text not null,
  worker_id        text,
  status           text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'canceled')),
  build_config     jsonb not null,
  error_code       text,
  error_signature  text,
  exit_code        int,
  log_lines        int not null default 0,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  unique (deployment_id, attempt_no)
);

create table build_log_chunks (
  attempt_id   uuid not null references deployment_attempts(id) on delete cascade,
  seq          int not null,
  first_line   int not null,
  line_count   int not null,
  bytes        int not null,
  storage_key  text not null,
  primary key (attempt_id, seq)
);

-- Lifecycle rules, synced from packages/core by the migration runner.
create table deployment_transition_rules (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

create or replace function enforce_deployment_transition() returns trigger as $$
begin
  if new.status is distinct from old.status then
    if not exists (
      select 1 from deployment_transition_rules
      where from_status = old.status and to_status = new.status
    ) then
      raise exception 'illegal deployment transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$ language plpgsql;

create trigger deployments_transition
  before update on deployments
  for each row execute function enforce_deployment_transition();

-- Append-only event log: the deployment timeline and audit trail.
create table deployment_events (
  id             bigint generated always as identity primary key,
  deployment_id  uuid not null references deployments(id) on delete cascade,
  org_id         uuid not null references orgs(id) on delete cascade,
  type           text not null,
  from_status    text,
  to_status      text,
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index deployment_events_dep_idx on deployment_events(deployment_id, id);

create or replace function forbid_mutation() returns trigger as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$ language plpgsql;

create trigger deployment_events_append_only
  before update or delete on deployment_events
  for each row when (pg_trigger_depth() = 0 and current_setting('app.allow_event_delete', true) is distinct from 'on')
  execute function forbid_mutation();

create table repair_attempts (
  id               uuid primary key default gen_random_uuid(),
  deployment_id    uuid not null references deployments(id) on delete cascade,
  org_id           uuid not null references orgs(id) on delete cascade,
  attempt_no       int not null,          -- the failed attempt this repair responds to
  error_code       text not null,
  error_signature  text not null,
  strategy         text not null check (strategy in ('rule', 'ai')),
  rule_id          text,
  title            text not null,
  explanation      text not null,
  diagnosis        jsonb,
  config_changes   jsonb not null default '[]',
  diff             text,
  policy           jsonb,
  status           text not null check (status in ('proposed', 'applied', 'validated', 'failed', 'awaiting_approval', 'approved', 'rejected')),
  needs_approval   boolean not null default false,
  pr_url           text,
  decided_by       uuid references users(id) on delete set null,
  decided_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index repair_attempts_dep_idx on repair_attempts(deployment_id, created_at);
create index repair_attempts_org_status_idx on repair_attempts(org_id, status);

create table ai_usage (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references orgs(id) on delete cascade,
  repair_id   uuid references repair_attempts(id) on delete set null,
  provider    text not null,
  model       text not null,
  purpose     text not null check (purpose in ('classify', 'diagnose', 'patch')),
  tokens_in   int,
  tokens_out  int,
  latency_ms  int,
  outcome     text not null check (outcome in ('ok', 'error', 'invalid_output', 'rate_limited', 'timeout', 'circuit_open')),
  created_at  timestamptz not null default now()
);
create index ai_usage_org_created_idx on ai_usage(org_id, created_at);

-- ------------------------------------------------------------ job queue
create table jobs (
  id                bigint generated always as identity primary key,
  type              text not null,
  payload           jsonb not null default '{}',
  org_id            uuid references orgs(id) on delete cascade,
  priority          int not null default 0,
  status            text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead', 'canceled')),
  run_at            timestamptz not null default now(),
  attempts          int not null default 0,
  max_attempts      int not null default 5,
  lease_until       timestamptz,
  locked_by         text,
  cancel_requested  boolean not null default false,
  last_error        text,
  idempotency_key   text unique,
  dead_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Partial indexes keep the hot paths small as finished jobs accumulate.
create index jobs_ready_idx on jobs(type, priority desc, run_at, id) where status = 'queued';
create index jobs_running_org_idx on jobs(org_id) where status = 'running';
create index jobs_lease_idx on jobs(lease_until) where status = 'running';

-- -------------------------------------------------------------- outbox
create table outbox (
  id              bigint generated always as identity primary key,
  event_id        text not null unique,      -- ULID; consumers dedupe on it
  topic           text not null,
  key             text not null,             -- Kafka partition key
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  published_at    timestamptz
);
create index outbox_unpublished_idx on outbox(id) where published_at is null;

-- Consumer-side idempotency for at-least-once delivery.
create table processed_events (
  consumer      text not null,
  event_id      text not null,
  processed_at  timestamptz not null default now(),
  primary key (consumer, event_id)
);

-- Analytics projection, rebuilt from Kafka on replay.
create table analytics_builds (
  deployment_id   uuid primary key,
  org_id          uuid not null,
  project_id      uuid not null,
  outcome         text not null check (outcome in ('succeeded', 'failed', 'canceled', 'needs_input')),
  recovered_by    text,
  error_code      text,
  attempts        int not null,
  build_ms        int,
  queue_wait_ms   int,
  finished_at     timestamptz not null,
  source_event_id text not null
);
create index analytics_builds_org_idx on analytics_builds(org_id, finished_at);

create table dead_letters (
  id           bigint generated always as identity primary key,
  consumer     text not null,
  topic        text not null,
  event_id     text,
  payload      jsonb,
  error        text not null,
  attempts     int not null,
  created_at   timestamptz not null default now(),
  replayed_at  timestamptz
);

-- ------------------------------------------------- inbound/outbound webhooks
create table github_deliveries (
  delivery_id  text primary key,       -- X-GitHub-Delivery; same across redeliveries
  event        text not null,
  received_at  timestamptz not null default now()
);

create table webhook_endpoints (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  url                text not null,
  secret_ciphertext  bytea not null,
  secret_dek         bytea not null,
  key_version        int not null,
  events             text[] not null,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create table webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  endpoint_id      uuid not null references webhook_endpoints(id) on delete cascade,
  org_id           uuid not null references orgs(id) on delete cascade,
  event_id         text not null,
  event_type       text not null,
  payload          jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'dead')),
  attempts         int not null default 0,
  response_status  int,
  response_ms      int,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (endpoint_id, event_id)
);
create index webhook_deliveries_endpoint_idx on webhook_deliveries(endpoint_id, created_at desc);

-- -------------------------------------------------------- idempotency, audit
create table idempotency_keys (
  scope         text not null,          -- org:user (or org:token)
  key           text not null,
  request_hash  text not null,
  status_code   int,                    -- null while the first request is in flight
  response      jsonb,
  locked_until  timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (scope, key)
);
create index idempotency_keys_created_idx on idempotency_keys(created_at);

create table audit_events (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references orgs(id) on delete cascade,
  actor_user_id   uuid references users(id) on delete set null,
  actor_token_id  uuid references api_tokens(id) on delete set null,
  action          text not null,
  target_type     text,
  target_id       text,
  ip              inet,
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now()
);
create index audit_events_org_idx on audit_events(org_id, id desc);

-- ------------------------------------------------------- row-level security
-- Tenant tables are filtered by app.org_id, which withOrg() sets per
-- transaction. Policies apply to app_user; the owner role (migrations,
-- worker) is exempt by design and documented in docs/adr.
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'env_vars', 'deployments', 'deployment_attempts', 'deployment_events',
    'repair_attempts', 'ai_usage', 'api_tokens', 'webhook_endpoints', 'webhook_deliveries',
    'audit_events', 'analytics_builds'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I to app_user using (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) with check (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      t
    );
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

-- Tables app_user reads without tenant filtering (joined through tenant rows).
grant select on users, orgs, memberships, artifacts, build_log_chunks, deployment_transition_rules to app_user;
grant select, insert, update on idempotency_keys to app_user;
grant insert on jobs, outbox to app_user;
grant usage on all sequences in schema public to app_user;
