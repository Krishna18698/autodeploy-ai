/**
 * Builds the portfolio hover video from the deploy `capture.mjs --deploy` recorded:
 *   project/hover-video/autodeploy-hover.mp4         4 s, 1920×1080, 30 fps, H.264, no audio, loops
 *   project/hover-video/autodeploy-hover-poster.jpg  its first frame (the <video> poster)
 *
 *   node video.mjs               the whole deploy as a time-lapse: Building → Validate → Live
 *   node video.mjs --start=12.5  or 4 s in real time, from this many seconds into the recording
 *
 * Chrome's screencast only sends a frame when something repaints, so each output frame shows
 * the latest one painted by then. The time-lapse ends on the page loaded fresh once it was live
 * (capture.mjs saves it as .frames/live.jpg), then the last half second cross-fades into the
 * first, so the end matches the start and the loop has no jump.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VIDEO } from './config.mjs';

const FRAMES = path.join(VIDEO, '.frames');
const FPS = 30;
const SEG = 4.5; // seconds of picture; the loop's cross-fade overlaps FADE of them
const FADE = 0.5;
const HOLD = 0.9; // the time-lapse holds on the live page this long
const { frames, marks } = JSON.parse(fs.readFileSync(path.join(FRAMES, 'frames.json'), 'utf8'));
if (frames.length < 2) throw new Error('no recording: run `node capture.mjs --deploy` first');
const t0 = frames[0].t;
const at = (s) => marks.find((m) => m.status === s)?.t;
/** The frame on screen at time t. */
const shownAt = (t) => frames[Math.max(0, frames.findLastIndex((f) => f.t <= t))];

const arg = process.argv.find((a) => a.startsWith('--start='));
const picks = []; // one file per output frame
if (arg) {
  const start = t0 + Number(arg.slice(8));
  for (let k = 0; k < SEG * FPS; k++) picks.push(path.join(FRAMES, shownAt(start + k / FPS).file));
  console.log(`real time: ${arg.slice(8)}s → ${(Number(arg.slice(8)) + SEG).toFixed(1)}s`);
} else {
  const from = at('BUILDING') ?? t0;
  const to = at('ACTIVE') ?? frames.at(-1).t;
  const live = path.join(FRAMES, 'live.jpg');
  if (!fs.existsSync(live)) throw new Error('no live frame: run `node capture.mjs --live`');
  const n = Math.round((SEG - HOLD) * FPS);
  for (let k = 0; k < n; k++)
    picks.push(path.join(FRAMES, shownAt(from + ((to - from) * k) / (n - 1)).file));
  for (let k = 0; k < HOLD * FPS; k++) picks.push(live);
  console.log(`time-lapse: ${(to - from).toFixed(0)}s of deploy in ${SEG - HOLD}s, then live`);
}
const list = path.join(FRAMES, 'segment.txt');
fs.writeFileSync(
  list,
  `${picks.map((f) => `file '${f}'\nduration ${(1 / FPS).toFixed(6)}`).join('\n')}\nfile '${picks.at(-1)}'\n`,
);

const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const seg = path.join(FRAMES, 'segment.mp4');
ff(
  ...['-f', 'concat', '-safe', '0', '-i', list],
  ...['-vf', `fps=${FPS},scale=1920:1080:flags=lanczos`, '-t', String(SEG)],
  ...['-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', seg],
);

const out = path.join(VIDEO, 'autodeploy-hover.mp4');
const body = SEG - FADE;
ff(
  ...['-i', seg, '-filter_complex'],
  `[0:v]split[a][b];[a]trim=${FADE}:${SEG},setpts=PTS-STARTPTS[main];[b]trim=0:${FADE},setpts=PTS-STARTPTS[head];` +
    `[main][head]xfade=transition=fade:duration=${FADE}:offset=${body - FADE},format=yuv420p[v]`,
  ...['-map', '[v]', '-an', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow'],
  ...['-crf', '20', '-profile:v', 'high', '-movflags', '+faststart', out],
);
ff('-i', out, '-frames:v', '1', '-q:v', '2', path.join(VIDEO, 'autodeploy-hover-poster.jpg'));
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`✓ ${path.relative(process.cwd(), out)}  ${body}s · 1920×1080 · ${FPS} fps · ${kb} KB`);
