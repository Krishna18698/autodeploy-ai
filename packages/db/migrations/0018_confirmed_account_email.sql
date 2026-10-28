-- The account email (users.email) counts when matching a sign-in to an
-- account only once its owner proved they read it: a link we emailed was
-- opened, or Google vouched for the same address. Until then it only says
-- where notifications go. GitHub's public email and an address typed into
-- Settings start unconfirmed.
alter table users add column email_verified_at timestamptz;

-- One confirmed address, one account.
create unique index users_confirmed_email_idx on users (lower(email))
  where email_verified_at is not null;

-- Email accounts whose confirmed sign-in address is also their account email.
update users u set email_verified_at = p.verified_at
from user_passwords p
where p.user_id = u.id and p.verified_at is not null and lower(u.email) = p.email;

-- Links that confirm an account email carry the address they were sent to,
-- so a link stops counting once the account email changes.
alter table email_tokens add column email text;
alter table email_tokens drop constraint email_tokens_kind_check;
alter table email_tokens add constraint email_tokens_kind_check
  check (kind in ('verify', 'reset', 'email'));
