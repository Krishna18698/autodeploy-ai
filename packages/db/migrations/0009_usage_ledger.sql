-- Per-account usage that deleting a project can't undo. The daily deploy limit
-- and monthly build minutes used to be counted from deployments and their
-- attempts, which go away with their project: deploy, delete, repeat, and the
-- limits never bit. Triggers add to this ledger in the same transaction as the
-- deployment or the finished attempt, so it can't drift and no code path can
-- forget it. Days are UTC, like the limits' resets.
create table org_usage (
  org_id    uuid not null references orgs(id) on delete cascade,
  day       date not null,
  deploys   int not null default 0,
  build_ms  bigint not null default 0,
  primary key (org_id, day)
);

create function org_usage_count_deploy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into org_usage (org_id, day, deploys)
  values (new.org_id, (now() at time zone 'utc')::date, 1)
  on conflict (org_id, day) do update set deploys = org_usage.deploys + 1;
  return new;
end $$;

create trigger deployments_count_usage after insert on deployments
  for each row execute function org_usage_count_deploy();

create function org_usage_count_build_time() returns trigger
language plpgsql security definer set search_path = public as $$
declare added bigint;
begin
  added := coalesce(new.duration_ms, 0)
         - (case when tg_op = 'UPDATE' then coalesce(old.duration_ms, 0) else 0 end);
  if added > 0 then
    insert into org_usage (org_id, day, build_ms)
    values (new.org_id, (now() at time zone 'utc')::date, added)
    on conflict (org_id, day) do update set build_ms = org_usage.build_ms + excluded.build_ms;
  end if;
  return new;
end $$;

create trigger attempts_count_build_time after insert or update of duration_ms on deployment_attempts
  for each row execute function org_usage_count_build_time();

-- What is still on record today starts the ledger.
insert into org_usage (org_id, day, deploys)
select org_id, (created_at at time zone 'utc')::date, count(*)
from deployments group by 1, 2;
insert into org_usage (org_id, day, build_ms)
select org_id, (coalesce(finished_at, started_at) at time zone 'utc')::date, sum(duration_ms)
from deployment_attempts where duration_ms > 0 group by 1, 2
on conflict (org_id, day) do update set build_ms = excluded.build_ms;

alter table org_usage enable row level security;
create policy tenant_isolation on org_usage to app_user
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant select on org_usage to app_user;
