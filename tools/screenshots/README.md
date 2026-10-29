# Screenshot harness

Captures the **real product in production** (app.autodeploy.fyi, signed in with the smoke
suite's API token) on desktop and phone, and turns the captures into framed screens, a contact
sheet, portfolio covers, a featured image and a hover video. It also holds the end-to-end flows.

Output goes to `project/` at the repo root (gitignored).

## Run it

Uses the repository's own Playwright (`pnpm install` at the root), ffmpeg for the video, and
the token in `infra/deploy/.e2e-token`.

```bash
cd tools/screenshots
node capture.mjs            # every page; deploys nothing
node capture.mjs --deploy   # also deploys portfolio-ai once and records it (changes that live site)
node capture.mjs --live     # only the live deployment's page, timeline and the video's last frame
node compose.mjs            # frames, contact sheet, covers, featured
node video.mjs              # the hover video from the recorded deploy
# the flows (read-only; must pass), from the repo root:
#   pnpm exec playwright test -c tools/screenshots/playwright.config.mjs
```

`--deploy` is the only part that changes anything: one deploy of `DEPLOY_SLUG` (config.mjs).
Everything else only reads. The token is sent to the API's host and nowhere else.

## What you get

```
project/
  screens/raw/{desktop,mobile}/*.png     screen-sized (1440×900 @2x, 390×700 @3x)
  screens/full/{desktop,mobile}/*.png    whole pages, where they're longer
  screens/framed/{desktop,mobile}/*.png  browser window / phone bezel with its status bar
  contact-sheet.png                      everything, in the order of a deploy
  covers/cover-{1,2,3}.png|jpg           4:3 — 3200×2400 PNG, 1600×1200 JPG
  featured/autodeploy-featured.png|jpg   portfolio cover: headline, desktop deploy + phone
  featured/autodeploy-card.png|jpg       portfolio card image, built to read at ~300px wide
  featured/card-preview-*.png            each inside a card like the portfolio's own
  hover-video/autodeploy-hover.mp4       4 s loop, 1920×1080, 30 fps, H.264, no audio
  hover-video/autodeploy-hover-poster.jpg
```

The portfolio shows the top 16:9 of the 4:3 featured image, so everything that matters sits in
its top 900px.

## The screens, in order

Landing (hero, features, live logs, self-healing, measured numbers, architecture) → sign in →
import with the analysis and its evidence → project → build settings → deploy started → queued →
building with the log streaming → validating → live with its validated render → timeline →
rollback dialog (opened, never confirmed) → overview → projects → deployments → recovery →
analytics → a server-rendered app's runtime → command palette → a site AutoDeploy serves.

## How it stays honest and repeatable

- **Real data only.** Everything is the account's own projects and deployments. The dashboard is
  dark-only by design (there is no light theme to capture), and it shows no profile photos.
- **Fixed viewports, timezone (Asia/Kolkata) and locale (en-IN).** Times are the real ones.
- **Waits for the page, not a timer:** no "Loading" placeholders left, on-screen images loaded,
  and on a live deployment its stored log and validated render present.
- **The hover video** is the deploy recorded with Chrome's screencast, as a time-lapse from
  Building to Live, ending on the page loaded fresh once live; its last half second
  cross-fades into its first, so it loops without a jump. `node video.mjs --start=<s>` makes a
  real-time clip from that point in the recording instead.
- `.frames/` under `hover-video/` holds the recording (tens of MB); delete it once the video is
  as you want it.

## When the UI changes

Selectors are text and roles (headings, tab names, button labels, the log's "N lines" count) in
`capture.mjs` and `tests/flows.spec.mjs`. A capture that fails is named at the end of the run
and the rest carry on. Look at the contact sheet after every run.
