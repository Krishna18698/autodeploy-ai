// Checks every third-party key in infra/deploy/.env.prod against its provider,
// before anything is shipped. Prints one line per service and never a value.
//
//   pnpm keys:check
//
// Each check is the cheapest call that proves the key works: listing models or
// key info, a 5-token completion, an empty telemetry batch, one test event.

import { envelope, parseDsn } from '../packages/telemetry/src/errors';
import { readEnvProd } from './env-prod';

const get = readEnvProd();

type Result = { ok: boolean | null; detail: string };
const timed = async (fn: () => Promise<Response>) => {
  const t = performance.now();
  const r = await fn();
  return { r, ms: Math.round(performance.now() - t) };
};
const short = async (r: Response) =>
  (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);

async function chat(base: string, key: string, model: string): Promise<Result> {
  const { r, ms } = await timed(() =>
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Say OK' }],
      }),
      signal: AbortSignal.timeout(60_000),
    }),
  );
  return r.ok
    ? { ok: true, detail: `${model} answered in ${ms} ms` }
    : { ok: false, detail: `${model}: HTTP ${r.status} ${await short(r)}` };
}

const checks: Record<string, () => Promise<Result>> = {
  'NVIDIA (AI repair)': async () => {
    const key = get('NVIDIA_API_KEY');
    if (!key) return { ok: null, detail: 'NVIDIA_API_KEY not set' };
    return chat(
      'https://integrate.api.nvidia.com/v1',
      key,
      get('NVIDIA_MODEL') ?? 'deepseek-ai/deepseek-v4.1-flash',
    );
  },
  'OpenRouter (AI fallback)': async () => {
    const key = get('OPENROUTER_API_KEY');
    if (!key) return { ok: null, detail: 'OPENROUTER_API_KEY not set' };
    const info = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!info.ok) return { ok: false, detail: `key rejected: HTTP ${info.status}` };
    return chat(
      'https://openrouter.ai/api/v1',
      key,
      get('OPENROUTER_MODEL') ?? 'nvidia/nemotron-3-super-120b-a12b:free',
    );
  },
  'Cloudflare Workers AI (classifier)': async () => {
    const key = get('CF_AI_TOKEN');
    if (!key) return { ok: null, detail: 'CF_AI_TOKEN not set' };
    const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = (await r.json().catch(() => ({}))) as { result?: { status?: string } };
    return r.ok && body.result?.status === 'active'
      ? { ok: true, detail: 'token active' }
      : { ok: false, detail: `HTTP ${r.status} ${body.result?.status ?? ''}` };
  },
  'Resend (email)': async () => {
    const key = get('RESEND_API_KEY');
    if (!key) return { ok: null, detail: 'RESEND_API_KEY not set' };
    const r = await fetch('https://api.resend.com/domains', {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status} ${await short(r)}` };
    const domain = get('PLATFORM_DOMAIN') ?? 'autodeploy.dpdns.org';
    const { data = [] } = (await r.json()) as { data?: { name: string; status: string }[] };
    const d = data.find((x) => x.name === domain);
    if (!d) return { ok: false, detail: `key works; ${domain} not added in Resend yet` };
    return d.status === 'verified'
      ? { ok: true, detail: `${domain} verified` }
      : { ok: false, detail: `key works; ${domain} is "${d.status}" (DNS records pending)` };
  },
  'Grafana Cloud (telemetry)': async () => {
    const endpoint = get('OTEL_EXPORTER_OTLP_ENDPOINT');
    const raw = get('OTEL_EXPORTER_OTLP_HEADERS');
    if (!endpoint || !raw) return { ok: null, detail: 'OTLP endpoint/headers not set' };
    // OTLP header format: comma-separated key=value, values URL-encoded.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const pair of raw.split(',')) {
      const i = pair.indexOf('=');
      if (i > 0) headers[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    }
    const r = await fetch(`${endpoint.replace(/\/$/, '')}/v1/traces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resourceSpans: [] }),
    });
    return r.ok
      ? { ok: true, detail: 'accepted an empty trace batch' }
      : { ok: false, detail: `HTTP ${r.status} ${await short(r)}` };
  },
  'Sentry (errors)': async () => {
    const raw = get('SENTRY_DSN');
    if (!raw) return { ok: null, detail: 'SENTRY_DSN not set' };
    const dsn = parseDsn(raw);
    if (!dsn) return { ok: false, detail: 'SENTRY_DSN is not a valid DSN' };
    const { body } = envelope(
      dsn,
      'key-check',
      new Error('[key check] AutoDeploy test event, ignore'),
    );
    const r = await fetch(dsn.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': dsn.auth },
      body,
    });
    return r.ok
      ? { ok: true, detail: 'test event accepted (look for "[key check]" in Sentry)' }
      : { ok: false, detail: `HTTP ${r.status} ${await short(r)}` };
  },
};

let failed = 0;
for (const [name, check] of Object.entries(checks)) {
  const res = await check().catch((err: Error) => ({ ok: false, detail: err.message }));
  if (res.ok === false) failed++;
  const mark = res.ok === null ? '–' : res.ok ? '✓' : '✗';
  console.log(`${mark} ${name.padEnd(34)} ${res.detail}`);
}
process.exitCode = failed ? 1 : 0;
