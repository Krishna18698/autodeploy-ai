-- The API cancels a deployment's jobs inside the tenant transaction that
-- cancels the deployment. Jobs carry no tenant RLS (the worker claims across
-- orgs), so callers must only target jobs of deployments they already loaded
-- under RLS.
grant select, update on jobs to app_user;
