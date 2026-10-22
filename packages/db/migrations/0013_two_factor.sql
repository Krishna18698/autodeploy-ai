-- Two-step sign-in with an authenticator app (TOTP). The secret is envelope-
-- encrypted like project secrets; recovery codes are stored hashed and work
-- once. A session made by a sign-in that still needs a code is "mfa_pending"
-- and can do nothing but take that code; mfa_verified_at says when the
-- session last showed one (dangerous actions ask again after 10 minutes).
create table user_totp (
  user_id           uuid primary key references users(id) on delete cascade,
  secret_ciphertext bytea not null,
  secret_dek        bytea not null,
  key_version       int not null,
  confirmed_at      timestamptz,
  last_step         bigint not null default 0,
  created_at        timestamptz not null default now()
);
create table user_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz
);
create index user_recovery_codes_user_idx on user_recovery_codes (user_id);
alter table sessions add column mfa_pending boolean not null default false;
alter table sessions add column mfa_verified_at timestamptz;
