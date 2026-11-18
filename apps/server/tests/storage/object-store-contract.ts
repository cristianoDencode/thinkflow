import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
  type ObjectStore,
} from '../../src/shared/kernel/object-store';

export interface ContractSubject {
  store: ObjectStore;
  /** Every key used by the suite starts with this (shared buckets are cleaned by prefix). */
  keyPrefix: string;
  /** Whether `x-amz-meta-*` round-trips (the local driver ignores metadata). */
  supportsMetadata: boolean;
  cleanup(): Promise<void>;
}

export type ContractFactory = (options: { listPageSize: number }) => Promise<ContractSubject>;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of body) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

async function keysOf(store: ObjectStore, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const info of store.list(prefix)) out.push(info.key);
  return out;
}

/** Behavior every ObjectStore adapter must share. */
export function describeObjectStoreContract(name: string, factory: ContractFactory): void {
  describe(`ObjectStore contract: ${name}`, () => {
    let subject: ContractSubject;
    let store: ObjectStore;
    let p: string;

    beforeAll(async () => {
      subject = await factory({ listPageSize: 3 });
      store = subject.store;
      p = subject.keyPrefix;
    });
    afterAll(async () => {
      await subject.cleanup();
    });

    it('round-trips bytes with put/getBytes/getStream/head', async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 10, 13]);
      await store.put(`${p}rt/doc.pdf`, bytes, { contentType: 'application/pdf' });

      expect([...(await store.getBytes(`${p}rt/doc.pdf`))!]).toEqual([...bytes]);

      const stream = await store.getStream(`${p}rt/doc.pdf`);
      expect(stream).not.toBeNull();
      expect(stream!.info.size).toBe(bytes.byteLength);
      expect([...(await collect(stream!.body))]).toEqual([...bytes]);

      const info = await store.head(`${p}rt/doc.pdf`);
      expect(info).toMatchObject({
        key: `${p}rt/doc.pdf`,
        size: bytes.byteLength,
        contentType: 'application/pdf',
      });
      expect(Math.abs(info!.lastModified - Date.now())).toBeLessThan(10 * 60_000);
    });

    it('stores empty objects', async () => {
      await store.put(`${p}empty/x.md`, new Uint8Array(), { contentType: 'text/markdown' });
      expect((await store.getBytes(`${p}empty/x.md`))!.byteLength).toBe(0);
      const stream = await store.getStream(`${p}empty/x.md`);
      expect((await collect(stream!.body)).byteLength).toBe(0);
      expect((await store.head(`${p}empty/x.md`))!.size).toBe(0);
    });

    it('overwrites an existing key', async () => {
      await store.put(`${p}ow/a.html`, enc('um'), { contentType: 'text/html; charset=utf-8' });
      await store.put(`${p}ow/a.html`, enc('dois!'), { contentType: 'text/html; charset=utf-8' });
      expect(dec((await store.getBytes(`${p}ow/a.html`))!)).toBe('dois!');
      expect((await store.head(`${p}ow/a.html`))!.size).toBe(5);
    });

    it('round-trips ASCII metadata (drivers that support it) and rejects non-ASCII', async () => {
      await store.put(`${p}meta/a.html`, enc('x'), {
        contentType: 'text/html; charset=utf-8',
        metadata: { 'report-id': 'abc-123', app: 'thinkflow' },
      });
      const info = await store.head(`${p}meta/a.html`);
      if (subject.supportsMetadata) {
        expect(info!.metadata).toMatchObject({ 'report-id': 'abc-123', app: 'thinkflow' });
      }
      await expect(
        store.put(`${p}meta/b.html`, enc('x'), {
          contentType: 'text/html',
          metadata: { title: 'Relatório ção' },
        }),
      ).rejects.toThrow(/ASCII/);
    });

    it('returns null for missing keys (never throws)', async () => {
      expect(await store.getBytes(`${p}missing/none.pdf`)).toBeNull();
      expect(await store.getStream(`${p}missing/none.pdf`)).toBeNull();
      expect(await store.head(`${p}missing/none.pdf`)).toBeNull();
    });

    it('delete is idempotent', async () => {
      await store.put(`${p}del/a.md`, enc('x'), { contentType: 'text/markdown' });
      await store.delete(`${p}del/a.md`);
      await store.delete(`${p}del/a.md`);
      await store.delete(`${p}del/never-existed.md`);
      expect(await store.head(`${p}del/a.md`)).toBeNull();
    });

    it('deletePrefix removes only that prefix and counts', async () => {
      for (const key of ['dp/1/a.md', 'dp/1/v/b.md', 'dp/1/v/c.pdf', 'dp/10/a.md', 'dp/2/a.md']) {
        await store.put(`${p}${key}`, enc(key), { contentType: 'text/markdown' });
      }
      expect(await store.deletePrefix(`${p}dp/1/`)).toBe(3);
      expect(await keysOf(store, `${p}dp/`)).toEqual([`${p}dp/10/a.md`, `${p}dp/2/a.md`]);
      expect(await store.deletePrefix(`${p}dp/1/`)).toBe(0);
      expect(await store.deletePrefix(`${p}dp/none/`)).toBe(0);
    });

    it('deletePrefix requires a trailing slash', async () => {
      await expect(store.deletePrefix(`${p}dp`)).rejects.toThrow(/inválido/);
      await expect(store.deletePrefix('')).rejects.toThrow(/inválido/);
      await expect(store.deletePrefix('/')).rejects.toThrow(/inválido/);
    });

    it('lists in ascending key order across pages', async () => {
      const names = ['l/e.md', 'l/a.md', 'l/d/x.md', 'l/b.md', 'l/c.md', 'l/f.md', 'l/g.md'];
      for (const n of names) {
        await store.put(`${p}${n}`, enc(n), { contentType: 'text/markdown' });
      }
      await store.put(`${p}lx/other.md`, enc('o'), { contentType: 'text/markdown' });

      const listed = [];
      for await (const info of store.list(`${p}l/`)) listed.push(info);
      expect(listed.map((i) => i.key)).toEqual([...names].sort().map((n) => `${p}${n}`));
      expect(listed[0]!.size).toBe('l/a.md'.length);
      expect(await keysOf(store, `${p}no-such/`)).toEqual([]);
    });

    it('rejects invalid keys with a plain Error', async () => {
      const bad = [
        '',
        '../x',
        '/abs',
        'a//b',
        'a/../b',
        'a/./b',
        'a/',
        'A/b',
        'a b',
        'a/\u0001b',
        'a\\b',
        `a/${'x'.repeat(520)}`,
      ];
      for (const key of bad) {
        const ops = [
          store.put(key, enc('x'), { contentType: 'text/plain' }),
          store.getBytes(key),
          store.getStream(key),
          store.head(key),
          store.delete(key),
        ];
        for (const op of ops) {
          const err = await op.then(
            () => null,
            (e: unknown) => e,
          );
          expect(err, JSON.stringify(key)).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(ObjectStoreUnavailableError);
          expect(err).not.toBeInstanceOf(ObjectTooLargeError);
        }
      }
      await expect(keysOf(store, '../x')).rejects.toThrow(/inválido/);
    });

    it('enforces maxBytes on write and on read', async () => {
      await expect(
        store.put(`${p}max/a.md`, enc('123456'), { contentType: 'text/markdown', maxBytes: 5 }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      expect(await store.head(`${p}max/a.md`)).toBeNull();

      await store.put(`${p}max/b.md`, enc('123456'), { contentType: 'text/markdown' });
      await expect(store.getBytes(`${p}max/b.md`, { maxBytes: 5 })).rejects.toBeInstanceOf(
        ObjectTooLargeError,
      );
      await expect(store.getStream(`${p}max/b.md`, { maxBytes: 5 })).rejects.toBeInstanceOf(
        ObjectTooLargeError,
      );
      expect(dec((await store.getBytes(`${p}max/b.md`, { maxBytes: 6 }))!)).toBe('123456');
    });

    it('abort() on an unconsumed stream is safe and idempotent', async () => {
      await store.put(`${p}ab/a.pdf`, enc('conteudo'), { contentType: 'application/pdf' });
      const stream = await store.getStream(`${p}ab/a.pdf`);
      stream!.abort();
      stream!.abort();
      // the store keeps working afterwards
      expect(dec((await store.getBytes(`${p}ab/a.pdf`))!)).toBe('conteudo');
    });

    it('check() reports a healthy store', async () => {
      const health = await store.check();
      expect(health.available).toBe(true);
      expect(health.reason).toBeNull();
      expect(typeof store.location).toBe('string');
    });
  });
}
