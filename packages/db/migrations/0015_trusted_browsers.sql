-- Browsers where someone showed their authenticator code and chose to be
-- remembered. Signing in there skips the code until the trust runs out
-- (30 days from the code, or 14 days without use), unless the sign-in comes
-- from another country, over Tor, or after several wrong passwords. Only a
-- hash of the browser's token is stored, as for sessions.
create table trusted_browsers (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  country      text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index trusted_browsers_user_idx on trusted_browsers (user_id);
