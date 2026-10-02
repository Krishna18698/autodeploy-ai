# 5. Explicit SQL, row-level security as a second wall

Status: accepted · 2026-09

## Decision
Queries are written in SQL (postgres.js tagged templates) with hand-written
migrations, instead of an ORM. Tenant tables have RLS policies keyed on
`app.org_id`; API code runs tenant queries through `withOrg()`, which sets
that variable and drops to a role without BYPASSRLS. The deployment state
machine is enforced by a trigger reading a rules table synced from code.

## Why
The interesting parts — `SKIP LOCKED` claims, advisory locks, partial
indexes, triggers, RLS — are SQL-first features that an ORM would hide.
RLS means a missing `where org_id = …` returns nothing instead of leaking.
