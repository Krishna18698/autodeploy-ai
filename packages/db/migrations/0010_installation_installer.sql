-- Who installed the GitHub App (GitHub's numeric user id, from the
-- installation webhook's sender). Only an organisation's owners can install
-- an App on it, so the installer may use an organisation installation that no
-- AutoDeploy org has claimed yet; importing a project then claims it.
alter table github_installations add column installed_by bigint;
