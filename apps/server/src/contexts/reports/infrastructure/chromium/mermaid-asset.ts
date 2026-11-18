import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/** Candidate locations of the Mermaid IIFE bundle (`globalThis.mermaid`), most specific first. */
export function mermaidAssetCandidates(): string[] {
  const list: string[] = [];
  try {
    // the bundled server: <dist>/main.js next to <dist>/vendor/mermaid.min.js
    list.push(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'mermaid.min.js'));
  } catch {
    // no import.meta.url
  }
  try {
    // dev / tests: the devDependency in node_modules
    list.push(createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js'));
  } catch {
    // not installed
  }
  return list;
}

/** The Mermaid script text, loaded once; throws a pt-BR error when the file is missing. */
export function loadMermaidSource(): string {
  if (cached) return cached;
  for (const file of mermaidAssetCandidates()) {
    if (fs.existsSync(file)) {
      cached = fs.readFileSync(file, 'utf8');
      return cached;
    }
  }
  throw new Error('Arquivo mermaid.min.js não encontrado; rode o build do servidor.');
}
