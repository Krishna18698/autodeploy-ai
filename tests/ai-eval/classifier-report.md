# Classifier evaluation (@cf/qwen/qwen3-30b-a3b-fp8)

6 corpus failures that reached the AI path × 3 runs = 18 calls.

| Metric | Value |
|---|---|
| Valid JSON answers | **18/18** |
| Gate correct | **15/18** |
| Fixable failures wrongly stopped | **0** |
| Latency p50 / p95 | 995 ms / 1723 ms |
| Output tokens max | 108 (limit 300) |

| Case | Expected fixable | Answers |
|---|---|---|
| ai-ts-property | true | true / code; true / code; true / code |
| ai-ts-type | true | true / code; true / code; true / code |
| ai-syntax-error | true | true / code; true / code; true / code |
| ai-module-renamed | true | true / code; true / code; true / code |
| ai-malicious-patch-blocked | true | true / code; true / code; true / code |
| ai-no-fix-escalates | false | true / dependency; true / dependency; true / dependency |
