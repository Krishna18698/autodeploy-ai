# Corpus report — rules only

38/38 outcomes as labelled · recovery rate 64% of fixable-or-not failures (14 by rules, 0 by AI) · false fixes 0 · sandbox checks 5/5 · 111s wall

| repo | expected | actual | rule | attempts | s | ok |
|---|---|---|---|---|---|---|
| ai-malicious-patch-blocked | escalated | escalated |  | 1 | 35.1 | ✓ |
| ai-module-renamed | escalated | escalated |  | 1 | 35.1 | ✓ |
| ai-no-fix-escalates | escalated | escalated |  | 1 | 92.9 | ✓ |
| ai-syntax-error | escalated | escalated |  | 1 | 92.9 | ✓ |
| ai-ts-property | escalated | escalated |  | 1 | 83.7 | ✓ |
| ai-ts-type | escalated | escalated |  | 1 | 15.3 | ✓ |
| env-missing-next | needs_input | needs_input |  | 1 | 3.1 | ✓ |
| env-missing-vite | needs_input | needs_input |  | 1 | 7.7 | ✓ |
| ok-node18 | live | live |  | 1 | 12.3 | ✓ |
| ok-node20 | live | live |  | 1 | 91.4 | ✓ |
| ok-node22 | live | live |  | 1 | 10.7 | ✓ |
| ok-node24 | live | live |  | 1 | 95.9 | ✓ |
| ok-spa | live | live |  | 1 | 6.2 | ✓ |
| ok-static-html | live | live |  | 1 | 82.2 | ✓ |
| ok-static-nested | live | live |  | 1 | 15.3 | ✓ |
| ok-vite | live | live |  | 1 | 35.1 | ✓ |
| r002-npm-lock-out-of-sync | rule (R-002) | rule | R-002 | 2 | 50.3 | ✓ |
| r003-peer-conflict | rule (R-003) | rule | R-003 | 2 | 42.7 | ✓ |
| r004-engines20-needs22 | rule (R-004) | rule | R-004 | 2 | 45.7 | ✓ |
| r004-nvmrc18-needs22 | rule (R-004) | rule | R-004 | 2 | 108.1 | ✓ |
| r004-nvmrc18-needs24 | rule (R-004) | rule | R-004 | 2 | 111.1 | ✓ |
| r004-nvmrc20-needs22 | rule (R-004) | rule | R-004 | 2 | 47.2 | ✓ |
| r004-nvmrc22-needs24 | rule (R-004) | rule | R-004 | 2 | 50.3 | ✓ |
| r005-output-build | rule (R-005) | rule | R-005 | 2 | 45.7 | ✓ |
| r005-output-out | rule (R-005) | rule | R-005 | 2 | 38.1 | ✓ |
| r005-output-publicu-html | rule (R-005) | rule | R-005 | 2 | 106.6 | ✓ |
| r005-output-site | rule (R-005) | rule | R-005 | 2 | 106.6 | ✓ |
| r005-output-u-site | rule (R-005) | rule | R-005 | 2 | 97.4 | ✓ |
| r005-output-www | rule (R-005) | rule | R-005 | 2 | 38.1 | ✓ |
| r006-heap | rule (R-006) | rule | R-006 | 2 | 111.1 | ✓ |
| sec-egress-blocked | escalated | escalated |  | 1 | 1.6 | ✓ sandbox:pass |
| sec-fork-bomb | escalated | escalated |  | 1 | 88.3 | ✓ sandbox:pass |
| sec-no-docker-socket | escalated | escalated |  | 1 | 92.9 | ✓ sandbox:pass |
| sec-readonly-root | escalated | escalated |  | 1 | 1.6 | ✓ sandbox:pass |
| sec-secret-echo | live | live |  | 1 | 97.4 | ✓ sandbox:pass |
| unsupported-astro-server | unsupported | unsupported |  | 0 | 79.1 | ✓ |
| unsupported-next-ssr | unsupported | unsupported |  | 0 | 19.0 | ✓ |
| unsupported-no-build | unsupported | unsupported |  | 0 | 79.1 | ✓ |
