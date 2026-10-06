// Creates the AutoDeploy GitHub App in one click (GitHub's "app manifest" flow)
// and writes its credentials straight into infra/deploy/.env.prod.
//   node scripts/github-app.mjs [--name "AutoDeploy KS"]
// Opens GitHub with every setting pre-filled; you press "Create GitHub App".
// GitHub then redirects back here with a one-time code, which is exchanged for
// the App ID, client secret, webhook secret and private key. Nothing secret is
// printed.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, 'infra/deploy/.env.prod');
const env = readFileSync(envPath, 'utf8');
const domain = env.match(/^PLATFORM_DOMAIN=(.+)$/m)?.[1]?.trim();
if (!domain) throw new Error(`PLATFORM_DOMAIN missing in ${envPath}`);
const nameArg = process.argv.indexOf('--name');
const name = nameArg > 0 ? process.argv[nameArg + 1] : 'AutoDeploy KS';
const PORT = 3999;
const state = randomBytes(16).toString('hex');

const manifest = {
  name,
  url: `https://app.${domain}`,
  description: 'Self-healing static-site deploys: builds, repairs, previews.',
  public: false, // installable only on the owner's account
  redirect_url: `http://127.0.0.1:${PORT}/created`,
  callback_urls: [`https://api.${domain}/auth/github/callback`],
  request_oauth_on_install: false,
  setup_on_update: false,
  hook_attributes: { url: `https://api.${domain}/api/v1/webhooks/github`, active: true },
  default_permissions: {
    contents: 'write', // download source; push fix branches for "Open PR"
    pull_requests: 'write', // open AI-fix PRs, read PRs for previews
    statuses: 'write', // ✓/✗ on commits
    metadata: 'read',
  },
  default_events: ['push', 'pull_request'],
};

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const page = `<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<body style="background:#0a0c0f;color:#e8ebf0;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<form method="post" action="https://github.com/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<p>Opening GitHub with the AutoDeploy App settings pre-filled…</p>
<button style="font:inherit;padding:8px 14px">Continue to GitHub</button></form>
<script>document.forms[0].submit()</script>`;

function setEnv(text, key, value) {
  const line = `${key}=${value}`;
  return new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), () => line)
    : `${text.trimEnd()}\n${line}\n`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    return;
  }
  if (url.pathname !== '/created') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    res.writeHead(400).end('Missing code or state mismatch; start again.');
    return;
  }
  try {
    const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const app = await r.json();
    let next = readFileSync(envPath, 'utf8');
    next = setEnv(next, 'GITHUB_APP_ID', String(app.id));
    next = setEnv(next, 'GITHUB_APP_SLUG', app.slug);
    next = setEnv(next, 'GITHUB_APP_CLIENT_ID', app.client_id);
    next = setEnv(next, 'GITHUB_APP_CLIENT_SECRET', app.client_secret);
    next = setEnv(next, 'GITHUB_WEBHOOK_SECRET', app.webhook_secret ?? '');
    // One line in the env file; the API and worker turn \n back into newlines.
    next = setEnv(next, 'GITHUB_APP_PRIVATE_KEY', app.pem.trim().replaceAll('\n', '\\n'));
    writeFileSync(envPath, next, { mode: 0o600 });
    const install = `https://github.com/apps/${app.slug}/installations/new`;
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        `<body style="background:#0a0c0f;color:#e8ebf0;font:15px system-ui;padding:40px"><h2>✓ ${esc(app.name)} created</h2><p>Credentials saved to infra/deploy/.env.prod.</p><p>Last step: <a style="color:#22d3ee" href="${install}">install it on your repos</a> (choose “Only select repositories”).</p>`,
      );
    console.log(`✓ Created GitHub App "${app.name}" (id ${app.id}, slug ${app.slug}).`);
    console.log(
      `  Saved 6 GITHUB_* values to infra/deploy/.env.prod${app.webhook_secret ? '' : ' (no webhook secret returned: set one in the App settings)'}.`,
    );
    console.log(`  Next: install it → ${install}`);
  } catch (err) {
    res.writeHead(500).end('Exchange failed; see the terminal.');
    console.error('✗', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Opening ${url} (GitHub will ask you to confirm the App name and create it)…`);
  if (!process.env.NO_OPEN) execFile('open', [url]);
});
