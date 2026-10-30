import { mkdirSync, writeFileSync } from 'node:fs';

const greeting = process.env.E2E_GREETING;
if (!greeting) {
  console.error('Error: E2E_GREETING is missing. Set it in the project environment.');
  process.exit(1);
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const css = `:root{--accent:#d97706;--soft:#fef3c7}*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;padding:24px;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:radial-gradient(circle at 18% 12%,var(--soft),transparent 42%),radial-gradient(circle at 88% 90%,#e0e7ff,transparent 40%),#f8fafc}main{width:min(100%,560px);background:#fff;border:1px solid #e2e8f0;border-radius:20px;padding:clamp(24px,6vw,40px);box-shadow:0 24px 60px -24px rgba(15,23,42,.28)}.badge{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--accent);background:var(--soft);padding:4px 12px;border-radius:999px}.badge::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}h1{font-size:clamp(28px,7vw,36px);line-height:1.15;letter-spacing:-.02em;margin:20px 0 12px}p{color:#475569}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:#f1f5f9;padding:1px 6px;border-radius:6px}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin-top:28px;padding-top:24px;border-top:1px solid #e2e8f0;font-size:14px}dt{color:#94a3b8}dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f172a;overflow-wrap:anywhere}footer{margin-top:28px;font-size:13px;color:#94a3b8}footer a{color:inherit}`;
mkdirSync('dist', { recursive: true });
writeFileSync(
  'dist/index.html',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>A build that needed a variable · AutoDeploy demo</title><style>${css}</style></head><body>
<main data-check="e2e env ok: ${esc(greeting)}">
<span class="badge">Live · after a variable was set</span>
<h1>This build needed a setting.</h1>
<p>The first build stopped: <code>E2E_GREETING is missing</code>. AutoDeploy recognised a missing environment variable, marked the deploy as needing input instead of failed, and once the variable was set it deployed again.</p>
<dl>
<dt>Variable</dt><dd>E2E_GREETING</dd>
<dt>Its value</dt><dd>${esc(greeting)}</dd>
<dt>Stored</dt><dd>envelope-encrypted, never shown again</dd>
</dl>
<footer>Part of the <a href="https://app.autodeploy.fyi">AutoDeploy</a> demo.</footer>
</main></body></html>`,
);
