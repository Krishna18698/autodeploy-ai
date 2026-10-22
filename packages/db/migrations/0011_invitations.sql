-- Joining an organisation takes the invitee's consent: an admin's "add
-- member" creates an invitation, and only accepting it creates the membership
-- (before, any account could be added to any org without being asked).
create table invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null check (role in ('admin', 'member', 'viewer')),
  invited_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);
create index invitations_user_idx on invitations (user_id);
