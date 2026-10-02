# 4. Deterministic rules first, AI second, humans approve source changes

Status: accepted · 2026-09

## Decision
A failed build is classified into an error signature (normalized key line,
hashed). Ordered rules handle known causes by changing *configuration only*
(Node version, output dir, install flags, heap). Only unmatched,
code-shaped failures go to the AI gateway, which diagnoses and proposes a
unified diff. Every diff passes a policy (paths, size, no CI/env/scripts,
no suspicious additions), is rebuilt in a fresh sandbox, validated in a real
browser, and then waits for human approval. Same signature twice, or two
repairs, stops the loop.

## Why
Rules are free, instant, explainable and testable. Models are slow, cost
quota, and can be wrong or manipulated by repository text, so their output is
treated as untrusted input, schema-validated, and never auto-published.
