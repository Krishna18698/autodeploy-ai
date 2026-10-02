import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript source, so they're bundled in; npm
// dependencies stay external and are installed in the image.
export default defineConfig({
  entry: { main: 'src/main.ts', register: '../../packages/telemetry/src/register.ts' },
  format: 'esm',
  target: 'node24',
  clean: true,
  splitting: false,
  sourcemap: true,
  // Our packages are bundled; every npm dependency stays a real import,
  // resolved from the flat (hoisted) node_modules installed in the image.
  skipNodeModulesBundle: true,
  noExternal: [/^@autodeploy\//],
});
