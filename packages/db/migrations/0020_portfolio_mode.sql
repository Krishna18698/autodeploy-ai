-- Portfolio mode (DEPLOY_APPROVAL=approval): anyone can sign in and look
-- around the read-only demo org, but an account creates projects and deploys
-- only once a platform admin approves it. An account asks with a short note;
-- the admins are emailed and approve (or dismiss) it from Admin.
alter table orgs
  add column deploys_approved_at timestamptz,
  add column access_requested_at timestamptz,
  add column access_request_note text check (length(access_request_note) <= 500),
  -- The demo org (DEMO_ORG_NAME): marked, not found by slug, so no account
  -- that took the slug first could become it. There is at most one.
  add column is_demo boolean not null default false;
create unique index orgs_one_demo on orgs ((true)) where is_demo;

-- Every account so far was let in by hand (the sign-in allowlist): it keeps deploying.
update orgs set deploys_approved_at = now();
