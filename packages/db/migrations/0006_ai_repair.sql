-- Per-project switch for AI repair. When on, a failed build's log excerpt and
-- the files it points at are sent to the configured AI providers; some users
-- can't share their code with third parties.
alter table projects add column ai_repair boolean not null default true;
