// Copies the Mermaid browser bundle next to the compiled server (dist/vendor/mermaid.min.js).
// The Chromium diagram renderer loads it from there, so the production image does not need the
// 100+ MB `mermaid` package (it is a devDependency used only for this file).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const source = require.resolve('mermaid/dist/mermaid.min.js');
const target = path.join(root, 'dist', 'vendor', 'mermaid.min.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);

// The renderer reads `globalThis.mermaid`: fail the build if a future Mermaid stops providing it.
const head = fs.readFileSync(target, 'utf8');
if (!/globalThis(\.mermaid|\["mermaid"\]|\['mermaid'\])\s*=/.test(head)) {
  throw new Error('copy-vendor: mermaid.min.js does not expose globalThis.mermaid');
}
process.stdout.write(
  `copy-vendor: ${path.relative(root, target)} (${(head.length / 1e6).toFixed(1)} MB)\n`,
);
