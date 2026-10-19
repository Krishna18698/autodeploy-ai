-- Sign-ups are open (usage is limited per account), so new orgs start with a
-- smaller daily deploy allowance; existing orgs keep theirs.
alter table orgs alter column daily_deploy_quota set default 20;
