import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/contexts/databases/application/database-service';
import { FakeClock } from '../../src/shared/kernel/clock';
import { ConflictError, NotFoundError } from '../../src/shared/kernel/errors';
import { FakePgGateway } from './fake-pg-gateway';
import { MemoryColumnRuleRepository } from './memory-rules';
import { MemoryDatabaseRepository } from './memory-repo';

let fake: FakePgGateway;
let service: DatabaseService;
let clock: FakeClock;
let n = 0;
let rules: MemoryColumnRuleRepository;

const body = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  host: 'db.local',
  database: 'ecidade',
  user: 'leitor',
  password: 'segredo',
  ...extra,
});

beforeEach(() => {
  fake = new FakePgGateway();
  clock = new FakeClock();
  n = 0;
  rules = new MemoryColumnRuleRepository();
  service = new DatabaseService({
    repo: new MemoryDatabaseRepository(),
    gateway: fake,
    clock,
    ids: { next: () => `id-${++n}` },
    rules,
  });
});

describe('DatabaseService', () => {
  it('creates with defaults, hides the password and makes the first one default', async () => {
    const dto = await service.create(body('A'));
    expect(dto).toMatchObject({
      name: 'A',
      port: 5432,
      passwordSet: true,
      aiAccess: 'schema',
      isDefault: true,
    });
    expect(JSON.stringify(dto)).not.toContain('segredo');
    const second = await service.create(body('B'));
    expect(second.isDefault).toBe(false);
  });

  it('isDefault clears the others; list puts the default first then by name', async () => {
    await service.create(body('B'));
    await service.create(body('A'));
    const c = await service.create(body('C', { isDefault: true }));
    const list = await service.list();
    expect(list.map((x) => x.name)).toEqual(['C', 'A', 'B']);
    expect(list.filter((x) => x.isDefault)).toHaveLength(1);
    expect(list[0]!.id).toBe(c.id);
  });

  it('rejects duplicated names and invalid input', async () => {
    await service.create(body('A'));
    await expect(service.create(body('A'))).rejects.toBeInstanceOf(ConflictError);
    await expect(service.create({ name: '' })).rejects.toThrow();
  });

  it('update keeps the password when empty/absent, replaces it otherwise, and drops the pool', async () => {
    const dto = await service.create(body('A'));
    clock.advance(5);
    await service.update(dto.id, { host: 'novo.local', password: '' });
    expect(fake.invalidated).toEqual([dto.id]);
    const run = await service.test(dto.id);
    expect(run.ok).toBe(true);
    expect(fake.tested[0]).toMatchObject({ host: 'novo.local', password: 'segredo' });

    await service.update(dto.id, { password: 'outra' });
    await service.test(dto.id);
    expect(fake.tested[1]!.password).toBe('outra');
    expect(fake.tested[1]!.version).toBeGreaterThan(fake.tested[0]!.version);
  });

  it('update refuses a name taken by another connection', async () => {
    await service.create(body('A'));
    const b = await service.create(body('B'));
    await expect(service.update(b.id, { name: 'A' })).rejects.toBeInstanceOf(ConflictError);
    await expect(service.update(b.id, { name: 'B' })).resolves.toMatchObject({ name: 'B' });
  });

  it('delete promotes another connection to default', async () => {
    const a = await service.create(body('A'));
    await service.create(body('B'));
    await service.delete(a.id);
    expect(fake.invalidated).toContain(a.id);
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'B', isDefault: true });
    await expect(service.get(a.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('test() reports success, the write warning and never throws on failure', async () => {
    const dto = await service.create(body('A'));
    expect(await service.test(dto.id)).toMatchObject({
      ok: true,
      canWrite: false,
      currentUser: 'leitor',
      serverVersion: 'PostgreSQL 17.0',
    });

    fake.info = { ...fake.info, canWrite: true };
    const warn = await service.test(dto.id);
    expect(warn.ok).toBe(true);
    expect(warn.message).toContain('pode alterar dados');

    fake.failTest = 'password authentication failed';
    const failed = await service.test(dto.id);
    expect(failed.ok).toBe(false);
    expect(failed.canWrite).toBeNull();
    expect(failed.message.length).toBeGreaterThan(0);
    await expect(service.test('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('maps common connection errors to pt-BR messages', async () => {
    const dto = await service.create(body('A'));
    const cases: [string, string][] = [
      ['ECONNREFUSED', 'Conexão recusada'],
      ['ENOTFOUND', 'não encontrado'],
      ['28P01', 'Usuário ou senha incorretos'],
      ['3D000', 'não existe'],
      ['ETIMEDOUT', 'Tempo esgotado'],
    ];
    for (const [code, text] of cases) {
      fake.test = async () => {
        throw Object.assign(new Error('x'), { code });
      };
      const r = await service.test(dto.id);
      expect(r.message, code).toContain(text);
    }
  });

  it('runDirect runs read-only SQL as the analyst and never throws', async () => {
    const dto = await service.create(body('A', { maxRows: 2 }));
    const ok = await service.runDirect(dto.id, 'select * from contribuintes');
    expect(ok).toMatchObject({
      source: 'direct',
      purpose: null,
      error: null,
      rowCount: 2,
      truncated: true,
    });
    expect(ok.columns.map((c) => c.name)).toContain('cpf');
    expect(fake.queries[0]!.maxRows).toBe(2);

    const refused = await service.runDirect(dto.id, 'delete from contribuintes');
    expect(refused.error).toContain('Consulta recusada');
    expect(refused.rows).toEqual([]);
    expect(refused.columns).toEqual([]);
    expect(fake.queries).toHaveLength(1);

    fake.respond = () => {
      throw new Error('relation "x" does not exist');
    };
    const failed = await service.runDirect(dto.id, 'select * from x');
    // caught by the name check before Postgres is asked to run it
    expect(failed.error).toContain('"x" não existe');
    expect(failed.validation).toBe(true);
    expect(failed.source).toBe('direct');

    await expect(service.runDirect('nope', 'select 1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('name() returns null for unknown connections', async () => {
    const dto = await service.create(body('A'));
    expect(await service.name(dto.id)).toBe('A');
    expect(await service.name('nope')).toBeNull();
  });
});
