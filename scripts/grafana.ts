// Installs the operations dashboard and alert rules into Grafana Cloud and
// checks that AutoDeploy's metrics are arriving.
//
//   GRAFANA_URL=https://<stack>.grafana.net pnpm tsx scripts/grafana.ts            # read only
//   GRAFANA_URL=https://<stack>.grafana.net pnpm tsx scripts/grafana.ts --install  # write
//
// Uses a service-account token (role Editor) saved in infra/deploy/.grafana-token
// (git-ignored). The OTLP token the services send with is write-only and can't do this.
// Sources: infra/observability/grafana-dashboard.json and alerts.yaml.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tokenFile = resolve(root, 'infra/deploy/.grafana-token');
const base = process.env.GRAFANA_URL?.replace(/\/+$/, '');
const install = process.argv.includes('--install');
if (!process.argv.includes('--dry') && (!base || !existsSync(tokenFile))) {
  console.error('Set GRAFANA_URL and save a service-account token to infra/deploy/.grafana-token');
  process.exit(1);
}
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
const FOLDER = { uid: 'autodeploy', title: 'AutoDeploy' };
const GROUP = 'autodeploy';

async function grafana<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Keeps the rules editable in the Grafana UI.
      'x-disable-provenance': 'true',
      ...init.headers,
    },
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body: body as T };
}

function must<T>(r: { status: number; body: T }, what: string): T {
  if (r.status >= 300)
    throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

type Rule = { alert: string; expr: string; for?: string; summary?: string; runbook?: string };

/** Reads alerts.yaml, which is written in the small subset of YAML handled here. */
function readAlerts(): Rule[] {
  const lines = readFileSync(resolve(root, 'infra/observability/alerts.yaml'), 'utf8').split('\n');
  const rules: Rule[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const start = line.match(/^\s*- alert: (\S+)/);
    if (start?.[1]) {
      rules.push({ alert: start[1], expr: '' });
      continue;
    }
    const rule = rules.at(-1);
    const kv = line.match(/^(\s*)(expr|for|summary|runbook): ?(.*)$/);
    if (!rule || !kv) continue;
    const [, indent = '', key, value = ''] = kv;
    if (key === 'expr' && value === '|') {
      const block: string[] = [];
      while (
        (lines[i + 1] ?? '').match(/^\s*$/) === null &&
        (lines[i + 1] ?? '').search(/\S/) > indent.length
      )
        block.push((lines[++i] ?? '').trim());
      rule.expr = block.join(' ');
    } else if (key === 'expr') rule.expr = value;
    else if (key === 'for') rule.for = value;
    else if (key === 'summary') rule.summary = value;
    else if (key === 'runbook') rule.runbook = value;
  }
  for (const r of rules) if (!r.expr) throw new Error(`alerts.yaml: ${r.alert} has no expr`);
  return rules;
}

/** `query > 5` → the query plus a Grafana threshold, so a value of exactly 0 still compares. */
function split(expr: string): { query: string; type: 'gt' | 'lt'; value: number } {
  const m = expr.match(/^(.*?)\s*(>|<|==)\s*([\d.]+)\s*$/s);
  if (!m?.[1] || !m[2] || !m[3]) throw new Error(`can't split threshold from: ${expr}`);
  const value = Number(m[3]);
  if (m[2] === '==') return { query: m[1], type: 'gt', value: value - 0.5 };
  return { query: m[1], type: m[2] === '>' ? 'gt' : 'lt', value };
}

function toGrafana(r: Rule, promUid: string) {
  const { query, type, value } = split(r.expr);
  return {
    uid: `autodeploy-${r.alert.toLowerCase()}`.slice(0, 40),
    title: r.alert,
    folderUID: FOLDER.uid,
    ruleGroup: GROUP,
    condition: 'C',
    for: r.for ?? '0s',
    noDataState: 'OK',
    execErrState: 'Error',
    labels: { service: 'autodeploy' },
    annotations: {
      ...(r.summary && { summary: r.summary }),
      ...(r.runbook && {
        runbook_url: `https://github.com/Krishna18698/autodeploy-ai/blob/main/${r.runbook}`,
      }),
    },
    data: [
      {
        refId: 'A',
        datasourceUid: promUid,
        relativeTimeRange: { from: 3600, to: 0 },
        model: { refId: 'A', expr: query, instant: true },
      },
      {
        refId: 'B',
        datasourceUid: '__expr__',
        relativeTimeRange: { from: 0, to: 0 },
        model: { refId: 'B', type: 'reduce', expression: 'A', reducer: 'last' },
      },
      {
        refId: 'C',
        datasourceUid: '__expr__',
        relativeTimeRange: { from: 0, to: 0 },
        model: {
          refId: 'C',
          type: 'threshold',
          expression: 'B',
          conditions: [{ evaluator: { type, params: [value] } }],
        },
      },
    ],
  };
}

const dashboard = JSON.parse(
  readFileSync(resolve(root, 'infra/observability/grafana-dashboard.json'), 'utf8'),
);
const alerts = readAlerts();
if (process.argv.includes('--dry')) {
  // Offline: show the alert rules as they would be sent.
  console.log(
    JSON.stringify(
      alerts.map((a) => toGrafana(a, '<prometheus>')),
      null,
      1,
    ),
  );
  process.exit(0);
}

// 1. The token works and the Prometheus data source (where OTLP metrics land) exists.
const who = must(await grafana<{ name?: string; role?: string }>('/api/user'), 'token check');
console.log(`token ok (${who.name ?? 'service account'})`);
type DataSource = { uid: string; name: string; type: string; isDefault: boolean };
const sources = must(await grafana<DataSource[]>('/api/datasources'), 'data sources');
const prom =
  sources.find((d) => d.type === 'prometheus' && /grafanacloud-.*-prom$/.test(d.name)) ??
  sources.find((d) => d.type === 'prometheus');
if (!prom) throw new Error('no Prometheus data source in this stack');
console.log(`metrics data source: ${prom.name}`);

// 2. Which autodeploy_* metrics have arrived, and which dashboard/alert queries would be empty.
const names = await grafana<{ data?: string[] }>(
  `/api/datasources/proxy/uid/${prom.uid}/api/v1/label/__name__/values?${new URLSearchParams({
    'match[]': '{__name__=~"autodeploy_.*"}',
    start: String(Math.floor(Date.now() / 1000) - 24 * 3600),
  })}`,
);
const seen = new Set(names.body.data ?? []);
console.log(
  `autodeploy metrics in the last 24h: ${seen.size ? [...seen].sort().join(', ') : 'none'}`,
);
const queries = [
  ...dashboard.panels
    .flatMap((p: { targets?: { expr: string }[] }) => p.targets ?? [])
    .map((t: { expr: string }) => t.expr),
  ...alerts.map((a) => a.expr),
];
const used = new Set(queries.flatMap((q) => q.match(/autodeploy_[a-z_]+/g) ?? []));
const missing = [...used].filter((m) => !seen.has(m));
if (missing.length)
  console.log(`not seen yet (panels/alerts on these stay empty): ${missing.join(', ')}`);

// 3. What's installed.
const dash = await grafana(`/api/dashboards/uid/${dashboard.uid}`);
const rules = await grafana<{ uid: string }[]>('/api/v1/provisioning/alert-rules');
const ours = Array.isArray(rules.body)
  ? rules.body.filter((r) => r.uid.startsWith('autodeploy-'))
  : [];
console.log(
  `dashboard installed: ${dash.status === 200 ? 'yes' : 'no'} · alert rules installed: ${ours.length}/${alerts.length}`,
);

if (!install) {
  console.log('read only; run with --install to install the dashboard and alert rules');
  process.exit(0);
}

// 4. Install: folder, dashboard (overwrite), the whole rule group (replace).
const folder = await grafana(`/api/folders/${FOLDER.uid}`);
if (folder.status === 404)
  must(
    await grafana('/api/folders', { method: 'POST', body: JSON.stringify(FOLDER) }),
    'create folder',
  );
must(
  await grafana('/api/dashboards/db', {
    method: 'POST',
    body: JSON.stringify({
      dashboard: { ...dashboard, id: null },
      folderUid: FOLDER.uid,
      overwrite: true,
      message: 'scripts/grafana.ts',
    }),
  }),
  'install dashboard',
);
console.log(`dashboard: ${base}/d/${dashboard.uid}`);
must(
  await grafana(`/api/v1/provisioning/folder/${FOLDER.uid}/rule-groups/${GROUP}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: GROUP,
      folderUid: FOLDER.uid,
      interval: 60,
      rules: alerts.map((a) => toGrafana(a, prom.uid)),
    }),
  }),
  'install alert rules',
);
console.log(
  `alert rules: ${alerts.length} installed in folder ${FOLDER.title} (${base}/alerting/list)`,
);
