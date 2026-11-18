import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SecretBox } from '../../src/shared/infrastructure/crypto';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';
import {
  aiColumnRules,
  databaseConnections,
  piiVault,
} from '../../src/shared/infrastructure/db/schema';
import { FakeClock } from '../../src/shared/kernel/clock';
import { columnRefKey } from '../../src/contexts/privacy/domain/column-rule';
import { restore, tokenize } from '../../src/contexts/privacy/domain/tokenizer';
import { SqliteColumnRuleRepository } from '../../src/contexts/privacy/infrastructure/sqlite-column-rule-repository';
import { SqliteVaultStore } from '../../src/contexts/privacy/infrastructure/sqlite-vault';
import { seqIds } from '../helpers';

let handle: DbHandle | undefined;
afterEach(() => handle?.close());

function setup() {
  handle = openDatabase(':memory:');
  const clock = new FakeClock();
  const now = clock.now();
  for (const id of ['c1', 'c2']) {
    handle.db
      .insert(databaseConnections)
      .values({
        id,
        name: id,
        host: 'h',
        port: 5432,
        database: 'd',
        user: 'u',
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  return { db: handle.db, clock };
}

describe('SqliteColumnRuleRepository', () => {
  it('upserts, lists and deletes rules (identifiers are case-insensitive)', async () => {
    const { db, clock } = setup();
    const repo = new SqliteColumnRuleRepository(db, clock, seqIds());
    const first = await repo.upsert({
      connectionId: 'c1',
      schema: 'Public',
      table: 'CGM',
      column: 'Z01_Nome',
      action: 'tokenize',
      kind: 'NOME',
      origin: 'auto',
    });
    expect(first).toMatchObject({
      schema: 'public',
      table: 'cgm',
      column: 'z01_nome',
      action: 'tokenize',
      kind: 'NOME',
      origin: 'auto',
    });

    clock.advance(1000);
    const again = await repo.upsert({
      connectionId: 'c1',
      schema: 'public',
      table: 'cgm',
      column: 'z01_nome',
      action: 'reveal',
      kind: 'NOME', // ignored: only tokenize keeps a kind
      origin: 'analyst',
    });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ action: 'reveal', kind: null, origin: 'analyst' });
    expect(again.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await repo.list('c1')).toHaveLength(1);
    expect(await repo.list('c2')).toEqual([]);

    await repo.delete('c2', first.id); // wrong connection: nothing happens
    expect(await repo.list('c1')).toHaveLength(1);
    await repo.delete('c1', first.id);
    expect(await repo.list('c1')).toEqual([]);
  });

  it('finds rules with * fallback, most specific first', async () => {
    const { db, clock } = setup();
    const repo = new SqliteColumnRuleRepository(db, clock, seqIds());
    const base = { connectionId: 'c1', kind: null, origin: 'analyst' as const };
    await repo.upsert({ ...base, schema: '*', table: '*', column: 'nome', action: 'tokenize' });
    await repo.upsert({ ...base, schema: '*', table: 'cgm', column: 'nome', action: 'omit' });
    await repo.upsert({
      ...base,
      schema: 'public',
      table: 'cgm',
      column: 'nome',
      action: 'reveal',
    });
    await repo.upsert({ ...base, schema: 'public', table: '*', column: 'obs', action: 'omit' });

    const refs = [
      { schema: 'public', table: 'cgm', column: 'NOME' }, // exact
      { schema: 'fin', table: 'cgm', column: 'nome' }, // (*, table)
      { schema: 'fin', table: 'outra', column: 'nome' }, // (*, *)
      { schema: 'public', table: 'x', column: 'obs' }, // (schema, *)
      { schema: 'fin', table: 'x', column: 'obs' }, // none
      { schema: 'public', table: 'cgm', column: 'desconhecida' }, // none
    ];
    const found = await repo.findFor('c1', refs);
    const action = (i: number) => found.get(columnRefKey(refs[i]!))?.action;
    expect([0, 1, 2, 3, 4, 5].map(action)).toEqual([
      'reveal',
      'omit',
      'tokenize',
      'omit',
      undefined,
      undefined,
    ]);
    expect((await repo.findFor('c2', refs)).size).toBe(0);
    expect((await repo.findFor('c1', [])).size).toBe(0);
  });

  it('cascades when the connection is deleted', async () => {
    const { db, clock } = setup();
    const repo = new SqliteColumnRuleRepository(db, clock, seqIds());
    await repo.upsert({
      connectionId: 'c1',
      schema: '*',
      table: '*',
      column: 'cpf',
      action: 'tokenize',
      kind: 'CPF',
      origin: 'analyst',
    });
    db.delete(databaseConnections).where(eq(databaseConnections.id, 'c1')).run();
    expect(db.select().from(aiColumnRules).all()).toEqual([]);
  });
});

describe('migration 0011: legacy column lists become rules', () => {
  it('copies sensitive_columns as tokenize and reveal_columns as reveal (reveal wins)', async () => {
    // build the pre-0011 state by migrating a fresh DB and re-running the data step on new rows
    const { db, clock } = setup();
    const now = clock.now();
    db.insert(databaseConnections)
      .values({
        id: 'legacy',
        name: 'legacy',
        host: 'h',
        port: 1,
        database: 'd',
        user: 'u',
        sensitiveColumns: JSON.stringify(['Observacao', 'cpf', '  ']),
        revealColumns: JSON.stringify(['CPF', 'status']),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // the migration's INSERT...SELECT statements, extracted from the SQL file
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sqlText = fs.readFileSync(
      path.resolve(__dirname, '../../drizzle/0011_privacy.sql'),
      'utf8',
    );
    const inserts = sqlText.split('--> statement-breakpoint').filter((s) => /INSERT INTO/.test(s));
    expect(inserts).toHaveLength(2);
    const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client;
    for (const stmt of inserts) sqlite.exec(stmt);

    const repo = new SqliteColumnRuleRepository(db, clock, seqIds());
    const rules = (await repo.list('legacy')).map((r) => [r.column, r.action, r.schema, r.table]);
    expect(rules).toEqual([
      ['cpf', 'reveal', '*', '*'],
      ['observacao', 'tokenize', '*', '*'],
      ['status', 'reveal', '*', '*'],
    ]);
  });
});

describe('SqliteVaultStore', () => {
  it('gives stable tokens per scope, encrypts values and restores them', () => {
    const { db, clock } = setup();
    const store = new SqliteVaultStore(db, new SecretBox('test-secret'), clock);
    const a = store.forScope('conv-a');
    const b = store.forScope('conv-b');

    expect(a.tokenFor('CPF', '529.982.247-25')).toBe('[CPF_1]');
    expect(a.tokenFor('CPF', '52998224725')).toBe('[CPF_1]');
    expect(a.tokenFor('CPF', '111.444.777-35')).toBe('[CPF_2]');
    expect(a.tokenFor('NOME', 'JOAO DA SILVA')).toBe('[NOME_1]');
    expect(a.tokenFor('NOME', 'João da Silva')).toBe('[NOME_1]');
    // another scope has its own numbering
    expect(b.tokenFor('CPF', '111.444.777-35')).toBe('[CPF_1]');
    expect(a.valueOf('[CPF_2]')).toBe('111.444.777-35');
    expect(a.valueOf('[CPF_9]')).toBeUndefined();
    expect(b.valueOf('[NOME_1]')).toBeUndefined();

    const raw = db.select().from(piiVault).all();
    expect(raw).toHaveLength(4);
    const blob = JSON.stringify(raw);
    expect(blob).not.toContain('529.982');
    expect(blob).not.toContain('SILVA');
    expect(
      raw.every((r) => r.valueCipher.startsWith('v1:') && /^[0-9a-f]{64}$/.test(r.valueHash)),
    ).toBe(true);
  });

  it('lists the decrypted entries (cache refreshed on insert) and copies a scope', () => {
    const { db, clock } = setup();
    const store = new SqliteVaultStore(db, new SecretBox('test-secret'), clock);
    const a = store.forScope('conv-a');
    a.tokenFor('ENDERECO', 'Rua Xingu 123');
    expect([...a.entries()]).toEqual([
      { token: '[ENDERECO_1]', kind: 'ENDERECO', value: 'Rua Xingu 123' },
    ]);
    a.tokenFor('CPF', '529.982.247-25');
    expect([...a.entries()].map((e) => e.token).sort()).toEqual(['[CPF_1]', '[ENDERECO_1]']);

    store.copyScope('conv-a', 'conv-b');
    const b = store.forScope('conv-b');
    expect(b.valueOf('[CPF_1]')).toBe('529.982.247-25');
    expect(b.tokenFor('CPF', '52998224725')).toBe('[CPF_1]'); // dedup survives the copy
    expect(b.tokenFor('CPF', '111.444.777-35')).toBe('[CPF_2]');
    expect(a.valueOf('[CPF_2]')).toBeUndefined(); // the parent is not affected
    store.deleteScope('conv-a');
    expect(b.valueOf('[CPF_1]')).toBe('529.982.247-25');
  });

  it('is persistent across instances and works with tokenize/restore', () => {
    const { db, clock } = setup();
    const secrets = new SecretBox('test-secret');
    const text = 'CPF 529.982.247-25 de JOAO DA SILVA';
    const out = tokenize(text, new SqliteVaultStore(db, secrets, clock).forScope('s'));
    expect(out).toBe('CPF [CPF_1] de [NOME_1]');
    const later = new SqliteVaultStore(db, secrets, clock).forScope('s');
    expect(restore(out, later)).toBe(text);
    expect(tokenize('de novo 52998224725', later)).toBe('de novo [CPF_1]');
  });

  it('deleteScope forgets only that scope', () => {
    const { db, clock } = setup();
    const store = new SqliteVaultStore(db, new SecretBox('k'), clock);
    store.forScope('x').tokenFor('CPF', '1');
    store.forScope('y').tokenFor('CPF', '1');
    store.deleteScope('x');
    expect(store.forScope('x').valueOf('[CPF_1]')).toBeUndefined();
    expect(store.forScope('y').valueOf('[CPF_1]')).toBe('1');
    store.forScope('y').deleteScope();
    expect(db.select().from(piiVault).all()).toEqual([]);
  });

  it('keeps unknown tokens opaque when the secret changed', () => {
    const { db, clock } = setup();
    new SqliteVaultStore(db, new SecretBox('old'), clock).forScope('s').tokenFor('CPF', '1');
    const rotated = new SqliteVaultStore(db, new SecretBox('new'), clock).forScope('s');
    expect(rotated.valueOf('[CPF_1]')).toBeUndefined();
    // a new token does not collide with the old one
    expect(rotated.tokenFor('CPF', '1')).toBe('[CPF_2]');
  });
});
