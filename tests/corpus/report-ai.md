# Corpus report — rules + AI (mock provider)

38/38 outcomes as labelled · recovery rate 82% of fixable-or-not failures (14 by rules, 4 by AI) · false fixes 0 · sandbox checks 5/5 · 140s wall

| repo | expected | actual | rule | attempts | s | ok |
|---|---|---|---|---|---|---|
| ai-malicious-patch-blocked | escalated | escalated |  | 1 | 10.9 | ✓ |
| ai-module-renamed | ai | ai |  | 2 | 112.8 | ✓ |
| ai-no-fix-escalates | escalated | escalated |  | 1 | 120.3 | ✓ |
| ai-syntax-error | ai | ai |  | 2 | 137.0 | ✓ |
| ai-ts-property | ai | ai |  | 2 | 137.0 | ✓ |
| ai-ts-type | ai | ai |  | 2 | 140.0 | ✓ |
| env-missing-next | needs_input | needs_input |  | 1 | 7.9 | ✓ |
| env-missing-vite | needs_input | needs_input |  | 1 | 7.9 | ✓ |
| ok-node18 | live | live |  | 1 | 121.8 | ✓ |
| ok-node20 | live | live |  | 1 | 115.7 | ✓ |
| ok-node22 | live | live |  | 1 | 118.8 | ✓ |
| ok-node24 | live | live |  | 1 | 124.8 | ✓ |
| ok-spa | live | live |  | 1 | 6.4 | ✓ |
| ok-static-html | live | live |  | 1 | 118.8 | ✓ |
| ok-static-nested | live | live |  | 1 | 111.2 | ✓ |
| ok-vite | live | live |  | 1 | 111.2 | ✓ |
| r002-npm-lock-out-of-sync | rule (R-002) | rule | R-002 | 2 | 111.2 | ✓ |
| r003-peer-conflict | rule (R-003) | rule | R-003 | 2 | 111.2 | ✓ |
| r004-engines20-needs22 | rule (R-004) | rule | R-004 | 2 | 111.2 | ✓ |
| r004-nvmrc18-needs22 | rule (R-004) | rule | R-004 | 2 | 72.3 | ✓ |
| r004-nvmrc18-needs24 | rule (R-004) | rule | R-004 | 2 | 71.4 | ✓ |
| r004-nvmrc20-needs22 | rule (R-004) | rule | R-004 | 2 | 111.2 | ✓ |
| r004-nvmrc22-needs24 | rule (R-004) | rule | R-004 | 2 | 80.4 | ✓ |
| r005-output-build | rule (R-005) | rule | R-005 | 2 | 111.2 | ✓ |
| r005-output-out | rule (R-005) | rule | R-005 | 2 | 132.4 | ✓ |
| r005-output-publicu-html | rule (R-005) | rule | R-005 | 2 | 111.2 | ✓ |
| r005-output-site | rule (R-005) | rule | R-005 | 2 | 111.2 | ✓ |
| r005-output-u-site | rule (R-005) | rule | R-005 | 2 | 63.8 | ✓ |
| r005-output-www | rule (R-005) | rule | R-005 | 2 | 111.2 | ✓ |
| r006-heap | rule (R-006) | rule | R-006 | 2 | 111.2 | ✓ |
| sec-egress-blocked | escalated | escalated |  | 1 | 114.2 | ✓ sandbox:pass |
| sec-fork-bomb | escalated | escalated |  | 1 | 84.4 | ✓ sandbox:pass |
| sec-no-docker-socket | escalated | escalated |  | 1 | 112.7 | ✓ sandbox:pass |
| sec-readonly-root | escalated | escalated |  | 1 | 112.7 | ✓ sandbox:pass |
| sec-secret-echo | live | live |  | 1 | 124.8 | ✓ sandbox:pass |
| unsupported-astro-server | unsupported | unsupported |  | 0 | 111.1 | ✓ |
| unsupported-next-ssr | unsupported | unsupported |  | 0 | 111.1 | ✓ |
| unsupported-no-build | unsupported | unsupported |  | 0 | 111.1 | ✓ |
