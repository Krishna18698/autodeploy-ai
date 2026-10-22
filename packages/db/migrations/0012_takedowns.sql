-- Abuse handling: a platform admin can take one site offline, or suspend a
-- whole account (every site offline, no new projects or deploys). The edge
-- then answers the site's addresses with a "taken down" notice.
alter table projects add column taken_down_at timestamptz;
alter table projects add column taken_down_reason text;
alter table orgs add column suspended_at timestamptz;
alter table orgs add column suspended_reason text;
create index projects_taken_down_idx on projects (taken_down_at) where taken_down_at is not null;
