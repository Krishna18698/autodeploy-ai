// Sets up the platform domain for sending email through Resend.
//
//   pnpm tsx scripts/resend-domain.ts            # status + DNS records (read only)
//   pnpm tsx scripts/resend-domain.ts --create   # add the domain to Resend first
//   pnpm tsx scripts/resend-domain.ts --verify   # ask Resend to check DNS again
//
// The records are written to infra/terraform/email.auto.tfvars.json (git-ignored),
// so `terraform plan/apply` in infra/terraform creates them in Cloudflare.
// Reads RESEND_API_KEY and PLATFORM_DOMAIN from infra/deploy/.env.prod.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnvProd } from './env-prod';

const root = resolve(import.meta.dirname, '..');
const get = readEnvProd();
const key = get('RESEND_API_KEY');
const domain = get('PLATFORM_DOMAIN') ?? 'autodeploy.dpdns.org';
if (!key) {
  console.error('RESEND_API_KEY is not set in infra/deploy/.env.prod');
  process.exit(1);
}

type Record_ = {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  status: string;
};
type Domain = { id: string; name: string; status: string; records?: Record_[] };

async function resend<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  });
  if (!r.ok)
    throw new Error(`Resend ${init.method ?? 'GET'} ${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

const { data = [] } = await resend<{ data?: Domain[] }>('/domains');
let found = data.find((d) => d.name === domain);
if (!found && process.argv.includes('--create')) {
  found = await resend<Domain>('/domains', {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
  });
  console.log(`added ${domain} to Resend`);
}
if (!found) {
  console.log(`${domain} is not in Resend yet; run again with --create to add it.`);
  process.exit(0);
}
if (process.argv.includes('--verify')) {
  await resend(`/domains/${found.id}/verify`, { method: 'POST' });
  console.log('asked Resend to verify the DNS records again');
}
const d = await resend<Domain>(`/domains/${found.id}`);
console.log(`${d.name}: ${d.status}`);
const records = (d.records ?? []).map((r) => ({
  type: r.type,
  // Resend may give the full name; Cloudflare records here are zone-relative.
  name: r.name.endsWith(`.${domain}`) ? r.name.slice(0, -domain.length - 1) : r.name,
  content: r.value,
  ...(r.priority !== undefined && { priority: Number(r.priority) }),
}));
for (const [i, r] of records.entries())
  console.log(`  ${r.type.padEnd(4)} ${r.name.padEnd(22)} ${d.records?.[i]?.status ?? ''}`);
const out = resolve(root, 'infra/terraform/email.auto.tfvars.json');
writeFileSync(out, `${JSON.stringify({ email_dns_records: records }, null, 2)}\n`);
console.log(`wrote ${records.length} records to infra/terraform/email.auto.tfvars.json`);
