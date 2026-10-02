# 1. Jobs live in Postgres; events flow through Kafka

Status: accepted · 2026-09

## Context
Deployments are units of work (analyze, build, recover, activate) that need
per-job leases, retries with backoff, cancellation, delays, and a dead-letter
state. Separately, several independent parts of the system react to the same
facts: the live UI, notifications/webhooks, and analytics.

## Decision
- **Work** is a row in `jobs`, claimed with `FOR UPDATE SKIP LOCKED`, held by a
  heartbeat-extended lease, requeued by a reaper when a worker dies.
- **Facts** are written to an outbox in the same transaction as the state
  change, relayed to Kafka, and consumed by three independent consumer groups.

## Why not Kafka for jobs?
A partition is a log. A 10-minute build at the head of a partition blocks
every job behind it, per-job retry/delay/cancel has to be rebuilt on top, and
"done" is an offset, not a row you can inspect. Postgres already gives
transactions with the deployment row being updated.

## Why Kafka at all, at this scale?
Not throughput. Three consumers with their own pace and failure handling, and
**replay**: the analytics projection is rebuilt from the topic on demand
(`pnpm replay:analytics`). Postgres alone could carry the events; Kafka makes
the fan-out and replay first-class. Measured: 72 events replayed into 5 rows
in 550 ms.

## Consequences
- At-least-once delivery end to end; every consumer is idempotent
  (`processed_events`, keyed by the event's ULID).
- One more stateful service (~1.5 GB heap budget on the VM).
