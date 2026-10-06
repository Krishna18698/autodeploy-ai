# Demo recording

`apps/web/public/demo/self-heal.mp4` (shown from the landing page's "Watch a
self-heal" button) is recorded, not edited: a real run of the local stack.

- `acme-shop/`: a small Vite + TypeScript shop with a real type error
  (`TS2322` in `src/price.ts`). `.autodeploy/mock-fix.diff` is what the mock AI
  provider proposes; with a real provider configured, the model writes the fix.
- `record-self-heal.ts`: imports it, waits for the failed build, the AI patch,
  the rebuild and validation, approves it, and opens the live site.

```bash
cp -R tests/demo/acme-shop /tmp/acme-shop
pnpm infra:up
APP_URL=http://localhost:3100 ./scripts/dev.sh start api
./scripts/dev.sh start worker && ./scripts/dev.sh start edge
(cd apps/web && pnpm build && API_URL=http://127.0.0.1:4000 npx next start -p 3100) &
pnpm tsx tests/demo/record-self-heal.ts /tmp/acme-shop
ffmpeg -i tests/demo/out/*.webm -vf "setpts=PTS/1.15,fps=30" -c:v libx264 -crf 27 \
  -pix_fmt yuv420p -movflags +faststart -an apps/web/public/demo/self-heal.mp4
```
