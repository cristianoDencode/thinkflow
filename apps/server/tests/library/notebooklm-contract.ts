import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotebookLmError, type NotebookLmGateway } from '../../src/contexts/library/domain/ports';

export interface GatewayHandle {
  gateway: NotebookLmGateway;
  cleanup(): void;
}

/** Behaviour every NotebookLmGateway implementation must share (fake and CLI-backed). */
export function runGatewayContract(label: string, make: () => GatewayHandle): void {
  describe(`NotebookLmGateway contract: ${label}`, () => {
    let handle: GatewayHandle;
    let gateway: NotebookLmGateway;
    let dir: string;
    let file: string;

    beforeEach(() => {
      handle = make();
      gateway = handle.gateway;
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-nlm-contract-'));
      file = path.join(dir, 'doc.pdf');
      fs.writeFileSync(file, 'fake pdf bytes');
    });
    afterEach(() => {
      handle.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('check reports the connected account', async () => {
      const result = await gateway.check();
      expect(result.ok).toBe(true);
      expect(result.account).toBe('fake.user@example.com');
      expect(result.message).toContain('fake.user@example.com');
    });

    it('creates a notebook and returns its id', async () => {
      const nb = await gateway.createNotebook('Thinkflow — Contratos');
      expect(nb.id).toEqual(expect.any(String));
      expect(nb.id.length).toBeGreaterThan(0);
    });

    it('adds a file source, waits for it and removes it', async () => {
      const nb = await gateway.createNotebook('Docs');
      const { sourceId } = await gateway.addSource(nb.id, {
        bytes: new Uint8Array(fs.readFileSync(file)),
        fileName: 'doc.pdf',
        title: 'Contrato.pdf',
        mimeType: 'application/pdf',
      });
      expect(sourceId).toEqual(expect.any(String));
      await expect(gateway.waitSourceReady(nb.id, sourceId, 5000)).resolves.toBeUndefined();
      await expect(gateway.deleteSource(nb.id, sourceId)).resolves.toBeUndefined();
      await expect(gateway.deleteNotebook(nb.id)).resolves.toBeUndefined();
    });

    it('answers with citations mapped to source ids', async () => {
      const answer = await gateway.ask('nb_1', 'Qual o prazo?', { timeoutMs: 10_000 });
      expect(answer.answer).toContain('[1]');
      expect(answer.references.length).toBeGreaterThan(0);
      for (const ref of answer.references) {
        expect(ref).toEqual({
          sourceId: expect.any(String),
          citationNumber: expect.any(Number),
          citedText: expect.any(String),
        });
      }
    });

    it('restricts the answer to the requested sources', async () => {
      const answer = await gateway.ask('nb_1', 'Qual o prazo?', {
        sourceIds: ['src_a', 'src_b'],
        timeoutMs: 10_000,
      });
      expect(answer.references.map((r) => r.sourceId)).toEqual(['src_a', 'src_b']);
    });

    it('maps failures to NotebookLmError kinds', async () => {
      await expect(gateway.ask('nb_1', '__RATE__', { timeoutMs: 10_000 })).rejects.toMatchObject({
        name: 'NotebookLmError',
        kind: 'rate_limited',
      });
      await expect(gateway.ask('nb_1', '__AUTH__', { timeoutMs: 10_000 })).rejects.toMatchObject({
        kind: 'auth',
      });
      await expect(gateway.ask('nb_1', '__TIMEOUT__', { timeoutMs: 400 })).rejects.toBeInstanceOf(
        NotebookLmError,
      );
      await expect(gateway.ask('nb_1', '__TIMEOUT__', { timeoutMs: 400 })).rejects.toMatchObject({
        kind: 'timeout',
      });
    });
  });
}
