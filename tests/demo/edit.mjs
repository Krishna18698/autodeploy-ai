// Cuts the recording into the landing page video: people-paced parts at normal
// speed, the waiting (builds, the AI at work, publishing) sped up and labelled
// as such. Nothing is cut out or reordered.
//   node tests/demo/edit.mjs   (after record-self-heal.ts; needs ffmpeg)
// Writes apps/web/public/demo/self-heal.mp4 and self-heal.jpg (the poster: the
// AI's patch on screen).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
const video = readdirSync(outDir).find((f) => f.endsWith('.webm'));
if (!video) throw new Error('no recording in tests/demo/out');
const m = JSON.parse(readFileSync(join(outDir, 'marks.json'), 'utf8'));
const pub = join(here, '../../apps/web/public/demo');

// [from, to, speed]
const segments = [
  [0, m.analysis, 1.5],
  [m.analysis, m.building, 1],
  [m.building, m.failed, 4],
  [m.failed, m.patched, 8],
  [m.patched, m.approve, 1],
  [m.approve, m.live, 4],
  [m.live, m.end, 1],
].filter(([a, b]) => b > a);

// "4× speed" labels as images (any ffmpeg can overlay; not every one can draw text).
const speeds = [...new Set(segments.map(([, , s]) => s).filter((s) => s > 1.5))];
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const s of speeds) {
  await page.setContent(
    `<body style="margin:0;background:transparent"><span id="l" style="display:inline-block;padding:6px 12px;border-radius:8px;background:rgba(0,0,0,.6);color:#f2f3f5;font:500 18px system-ui,sans-serif">▸▸ ${s}× speed</span></body>`,
  );
  await page
    .locator('#l')
    .screenshot({ path: join(outDir, `label-${s}.png`), omitBackground: true });
}
await browser.close();

const inputs = ['-i', join(outDir, video)];
const labelInput = new Map(speeds.map((s, i) => [s, i + 1]));
for (const s of speeds) inputs.push('-loop', '1', '-i', join(outDir, `label-${s}.png`));
const uses = new Map(speeds.map((s) => [s, segments.filter(([, , x]) => x === s).length]));
const splits = speeds.map((s) => {
  const n = uses.get(s);
  const outs = Array.from({ length: n }, (_, k) => `[l${s}_${k}]`).join('');
  return `[${labelInput.get(s)}:v]split=${n}${outs}`;
});
const seen = new Map();
const parts = segments.map(([a, b, s], i) => {
  const cut = `[0:v]trim=start=${a}:end=${b},setpts=(PTS-STARTPTS)/${s}`;
  if (s <= 1.5) return `${cut}[v${i}]`;
  const k = seen.get(s) ?? 0;
  seen.set(s, k + 1);
  return `${cut}[c${i}];[c${i}][l${s}_${k}]overlay=x=W-w-24:y=24:shortest=1[v${i}]`;
});
const filter = `${[...splits, ...parts].join(';')};${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0,fps=30[out]`;
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  ...inputs,
  '-filter_complex',
  filter,
  '-map',
  '[out]',
  '-c:v',
  'libx264',
  '-crf',
  '26',
  '-preset',
  'slow',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  '-an',
  join(pub, 'self-heal.mp4'),
]);
const poster = (m.patched + m.approve) / 2;
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-ss',
  String(poster),
  '-i',
  join(outDir, video),
  '-frames:v',
  '1',
  '-q:v',
  '3',
  join(pub, 'self-heal.jpg'),
]);
// A new recording gets a new address: browsers and Cloudflare keep the video
// for hours, and would otherwise go on showing the old one under the same URL.
const version = createHash('sha256')
  .update(readFileSync(join(pub, 'self-heal.mp4')))
  .digest('hex')
  .slice(0, 10);
writeFileSync(
  join(here, '../../apps/web/components/landing/demo-version.ts'),
  `// Written by tests/demo/edit.mjs: the recording's fingerprint, so a new one gets a new URL.\nexport const DEMO_VERSION = '${version}';\n`,
);
const length = segments.reduce((t, [a, b, s]) => t + (b - a) / s, 0);
console.log(`self-heal.mp4: ${length.toFixed(1)} s (from ${m.end.toFixed(0)} s recorded)`);
