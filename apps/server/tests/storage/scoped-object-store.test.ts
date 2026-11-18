import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import {
  scopeObjectStore,
  type ObjectNamespace,
} from '../../src/shared/kernel/scoped-object-store';
import { describeObjectStoreContract } from './object-store-contract';

const bytes = new Uint8Array([1, 2, 3]);
const opts = { contentType: 'application/pdf' };

describeObjectStoreContract('scoped (memory)', async () => ({
  store: scopeObjectStore(new MemoryObjectStore(), 'prod/thinkflow/', 'library'),
  keyPrefix: '',
  supportsMetadata: true,
  cleanup: async () => undefined,
}));

describe('scopeObjectStore', () => {
  it('writes under <prefix><namespace>/ and lists relative keys', async () => {
    const inner = new MemoryObjectStore();
    const lib = scopeObjectStore(inner, 'thinkflow/', 'library');
    await lib.put('l1/d1.pdf', bytes, opts);

    expect(await inner.head('thinkflow/library/l1/d1.pdf')).not.toBeNull();
    expect((await lib.head('l1/d1.pdf'))!.key).toBe('l1/d1.pdf');
    expect((await lib.getStream('l1/d1.pdf'))!.info.key).toBe('l1/d1.pdf');
    const keys: string[] = [];
    for await (const info of lib.list('')) keys.push(info.key);
    expect(keys).toEqual(['l1/d1.pdf']);
  });

  it('isolates namespaces: one module never sees or deletes the keys of another', async () => {
    const inner = new MemoryObjectStore();
    const lib = scopeObjectStore(inner, '', 'library');
    const docs = scopeObjectStore(inner, '', 'documents');
    await lib.put('x/a.pdf', bytes, opts);
    await docs.put('x/a.pdf', new Uint8Array([9]), opts);

    expect([...(await lib.getBytes('x/a.pdf'))!]).toEqual([1, 2, 3]);
    expect(await docs.deletePrefix('x/')).toBe(1);
    expect(await lib.getBytes('x/a.pdf')).not.toBeNull();
    const all: string[] = [];
    for await (const info of inner.list('')) all.push(info.key);
    expect(all).toEqual(['library/x/a.pdf']);
  });

  it('rejects unknown namespaces, bad prefixes and absolute keys', async () => {
    const inner = new MemoryObjectStore();
    expect(() => scopeObjectStore(inner, '', 'secrets' as ObjectNamespace)).toThrow('Namespace');
    expect(() => scopeObjectStore(inner, 'no-slash', 'library')).toThrow('STORAGE_PREFIX');
    const lib = scopeObjectStore(inner, '', 'library');
    await expect(lib.put('/etc/passwd', bytes, opts)).rejects.toThrow('inválida');
    await expect(lib.getBytes('')).rejects.toThrow('inválida');
  });

  it('passes outages through', async () => {
    const inner = new MemoryObjectStore();
    const lib = scopeObjectStore(inner, '', 'library');
    inner.fail('fora do ar');
    expect((await lib.check()).available).toBe(false);
    await expect(lib.put('a/b.pdf', bytes, opts)).rejects.toMatchObject({ httpStatus: 503 });
  });
});
