// k6 load test (run by tests/load/run.ts inside the grafana/k6 container).

import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const cfg = JSON.parse(open('/load/config.json'));

export const options = {
  scenarios: {
    // 50 different API tokens fire one deployment each, at the same instant.
    // Worst case: every deploy targets the same project (numbering serialises them).
    burst: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      exec: 'deploy',
      maxDuration: '60s',
    },
    // Realistic: 50 deploys spread over 50 projects.
    spread: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      exec: 'deploySpread',
      maxDuration: '60s',
      startTime: '5s',
    },
    // Meanwhile 20 dashboards poll lists and details.
    reads: { executor: 'constant-vus', vus: 20, duration: '30s', exec: 'read', startTime: '0s' },
  },
  thresholds: {
    'http_req_duration{scenario:burst}': ['p(95)<1000'],
    'http_req_duration{scenario:spread}': ['p(95)<400'],
    'http_req_duration{kind:read}': ['p(95)<250'],
    'checks{kind:write}': ['rate==1'],
  },
};

export function deploy() {
  // VU ids are numbered across scenarios; the scenario's own iteration index is 0..49.
  const i = exec.scenario.iterationInTest;
  const token = cfg.tokens[i];
  const res = http.post(
    `${cfg.api}/api/v1/projects/${cfg.projectId}/deployments`,
    JSON.stringify({ kind: 'preview' }),
    {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': `load-${i}-${cfg.run}`,
      },
      tags: { kind: 'write' },
    },
  );
  check(res, { 'deployment created': (r) => r.status === 201 }, { kind: 'write' });
}

export function deploySpread() {
  const i = exec.scenario.iterationInTest;
  const res = http.post(
    `${cfg.api}/api/v1/projects/${cfg.spreadProjects[i]}/deployments`,
    JSON.stringify({ kind: 'preview' }),
    {
      headers: {
        authorization: `Bearer ${cfg.tokens[i]}`,
        'content-type': 'application/json',
        'idempotency-key': `spread-${i}-${cfg.run}`,
      },
      tags: { kind: 'write' },
    },
  );
  check(res, { 'deployment created': (r) => r.status === 201 }, { kind: 'write' });
}

export function read() {
  const token = cfg.tokens[exec.vu.idInTest % cfg.tokens.length];
  const h = { headers: { authorization: `Bearer ${token}` }, tags: { kind: 'read' } };
  http.get(`${cfg.api}/api/v1/deployments?limit=30`, h);
  http.get(`${cfg.api}/api/v1/projects/${cfg.projectId}`, h);
}
