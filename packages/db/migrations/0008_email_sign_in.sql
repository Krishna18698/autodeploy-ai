-- Email + password sign-in, next to GitHub. A user has GitHub, a password, or
-- both; email accounts get logins with "_", which GitHub logins never contain,
-- so they can never be mistaken for a GitHub account (installations are
-- matched by login).
create table user_passwords (
  user_id      uuid primary key references users(id) on delete cascade,
  email        text not null,                  -- lower-cased; what people sign in with
  hash         text not null,                  -- scrypt$N$r$p$salt$hash
  verified_at  timestamptz,                    -- null until the emailed link is opened
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index user_passwords_email_idx on user_passwords (email);

-- One-time links sent by email. Only the hash is stored; issuing a new link
-- retires the earlier ones of the same kind.
create table email_tokens (
  token_hash  text primary key,                 -- sha256 of the token in the link
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null check (kind in ('verify', 'reset')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index email_tokens_user_idx on email_tokens (user_id, kind);
