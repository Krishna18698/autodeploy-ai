# Chaos report

| scenario | outcome | measured | ok |
|---|---|---|---|
| worker SIGKILL mid-build | attempt 1 marked canceled/WORKER_LOST; attempt 2 → ACTIVE | rebuild started 36.3 s after the kill (lease 30 s + reaper ≤15 s) | ✓ |
| Kafka stopped during a deployment | deployment still went ACTIVE; 11 events queued in the outbox, 0 left after restart | backlog drained 6.5 s after Kafka returned (incl. broker startup) | ✓ |
| all worker DB connections terminated | 7 connections killed; deployment → ACTIVE after 1 attempt(s) | pool reconnects transparently; heartbeats resume | ✓ |
| object storage down at upload time | deployment → ACTIVE after 2 attempt(s) | recovered 21.9 s after storage returned (retry with jittered backoff) | ✓ |
