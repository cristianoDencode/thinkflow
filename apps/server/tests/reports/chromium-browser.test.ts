import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChromiumBrowser } from '../../src/contexts/reports/infrastructure/chromium/chromium-browser';
import {
  loadMermaidSource,
  mermaidAssetCandidates,
} from '../../src/contexts/reports/infrastructure/chromium/mermaid-asset';

// These tests never start a real browser: they cover the degraded-mode behaviour.
describe('ChromiumBrowser (no browser needed)', () => {
  it('explains a configured path that does not exist', async () => {
    const browser = new ChromiumBrowser({ executablePath: () => '/nonexistent/chrome' });
    const status = await browser.status();
    expect(status).toMatchObject({ available: false, executablePath: '/nonexistent/chrome' });
    expect(status.reason).toContain('/nonexistent/chrome');
    expect(status.reason).toContain('Ajustes');
  });

  it('remembers a failed launch for a while and retries after the TTL or a new path', async () => {
    let now = 1_000;
    // exists on every platform, but is not an executable browser
    const notABrowser = fileURLToPath(import.meta.url);
    let path = notABrowser;
    const browser = new ChromiumBrowser({
      executablePath: () => path,
      failureTtlMs: 300_000,
      now: () => now,
    });
    const first = await browser.status();
    expect(first.available).toBe(false);
    expect(first.reason).toContain('Não foi possível iniciar o Chromium');

    // cached: the same message comes back without a new launch attempt
    const cachedAt = Date.now();
    expect((await browser.status()).reason).toBe(first.reason);
    expect(Date.now() - cachedAt).toBeLessThan(50);
    await expect(browser.use(async () => 1)).rejects.toThrow('Não foi possível iniciar');

    // changing the configured path clears the cache
    path = '/nonexistent/chrome';
    expect((await browser.status()).reason).toContain('/nonexistent/chrome');
    now += 400_000;
    path = notABrowser;
    expect((await browser.status()).available).toBe(false);
    await browser.close();
    await expect(browser.use(async () => 1)).rejects.toThrow('encerrado');
  });
});

describe('mermaid asset', () => {
  it('finds the IIFE bundle that exposes globalThis.mermaid', () => {
    expect(mermaidAssetCandidates().length).toBeGreaterThan(0);
    const source = loadMermaidSource();
    expect(source.length).toBeGreaterThan(1_000_000);
    expect(source).toMatch(/globalThis\["mermaid"\]\s*=/);
  });
});
