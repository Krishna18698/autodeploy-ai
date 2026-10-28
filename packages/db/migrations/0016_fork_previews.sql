-- A pull request from a fork is someone else's code. Its preview builds and
-- runs without the project's environment variables, which could otherwise be
-- printed into the public preview (found 2026-10-28; nothing recorded which
-- earlier previews came from forks, so they all stay false).
alter table deployments add column from_fork boolean not null default false;
