-- Classification of a failed attempt (excerpt, captures, candidate output
-- dirs), written by the build job and read by the recovery job.
alter table deployment_attempts add column error_detail jsonb;
alter table deployment_attempts add column duration_ms int;
