# Demo recording

`apps/web/public/demo/self-heal.mp4` (the landing page's "Watch a self-heal")
is a real run on the live product, real AI included, with only the waiting
sped up:

- `acme-shop/`: a small Vite + TypeScript shop with a real type error
  (`TS2322` in `src/price.ts`). The recorder imports it from this repository
  on GitHub, so it must be on `main`. (`.autodeploy/mock-fix.diff` is only for
  the local stack's mock AI provider.)
- `record-self-heal.ts`: imports it through the dashboard, waits for the
  failed build, the production AI's patch, the rebuild and the browser check,
  approves it, opens the live site, then deletes the project. It writes the
  video and `marks.json` (when each phase happened) to `out/`.
- `edit.mjs`: keeps the people-paced parts at normal speed and speeds up the
  waiting (build 4×, the AI and the rebuild 8×, publishing 4×), each sped-up
  part labelled; nothing is cut or reordered. It also takes the poster frame.

```bash
pnpm tsx tests/demo/record-self-heal.ts   # signs in with infra/deploy/.e2e-token
node tests/demo/edit.mjs                  # needs ffmpeg
```
