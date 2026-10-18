-- Server-rendered apps beyond Next.js (ADR 0008): each deployment records how
-- its server starts. Null on Next.js deployments built before this, which run
-- `node server.js` from the bundle root.
alter table deployments
  add column runtime_command text,
  add column runtime_workdir text;
