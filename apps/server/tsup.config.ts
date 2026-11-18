import { defineConfig } from 'tsup';

export default defineConfig({
  // storage-migrate: `node dist/storage-migrate.js` (STORAGE_DRIVER local → s3)
  entry: { main: 'src/main.ts', 'storage-migrate': 'src/cli/storage-migrate.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Inline the workspace package (it ships TS source); keep real deps external.
  noExternal: ['@thinkflow/shared'],
  // optionalDependency (native, per-platform binary): tsup only externalizes dependencies/peers.
  external: ['@napi-rs/canvas'],
});
