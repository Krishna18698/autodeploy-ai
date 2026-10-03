# Load report

```
http_req_duration..............: p(50)=3.83ms   p(95)=17.96ms  p(99)=34.39ms  max=780.54ms
      { expected_response:true }...: p(50)=13.79ms  p(95)=38.21ms  p(99)=219.15ms max=780.54ms
      { kind:read }................: p(50)=3.82ms   p(95)=17.77ms  p(99)=33.14ms  max=463.04ms
      { scenario:burst }...........: p(50)=666.82ms p(95)=761.83ms p(99)=773.39ms max=780.54ms
      { scenario:spread }..........: p(50)=241.86ms p(95)=275.7ms  p(99)=298.64ms max=301.39ms
{ scenario:burst }...........: p(50)=666.82ms p(95)=761.83ms p(99)=773.39ms max=780.54ms
{ scenario:spread }..........: p(50)=241.86ms p(95)=275.7ms  p(99)=298.64ms max=301.39ms
checks{kind:write}
http_reqs......................: 93536  3117.283535/s
```

- deployments created: 100/100 · built and ready: 100
- deployments with more than one build attempt: 0 · duplicate build jobs: 0
- queue wait p50 / p95: 76.5 s / 132.3 s (2 build slots on this machine)
- all 100 drained in 145.9 s
