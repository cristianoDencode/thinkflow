import type { DatabaseConnectionInput } from '@thinkflow/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/contexts/databases/application/database-service';
import { InMemoryVault } from '../../src/contexts/privacy/domain/vault';
import { FakeClock } from '../../src/shared/kernel/clock';
import { FakePgGateway } from './fake-pg-gateway';
import { MemoryColumnRuleRepository } from './memory-rules';
import { MemoryDatabaseRepository } from './memory-repo';

let fake: FakePgGateway;
let service: DatabaseService;
let n = 0;

const input: DatabaseConnectionInput = {
  name: 'e-Cidade',
  host: 'db.local',
  database: 'ecidade',
  user: 'leitor',
  password: 'segredo',
};

async function setup() {
  const created = await service.create(input);
  const vault = new InMemoryVault();
  const tools = await service.chatTools(created.id, {
    maxOutputChars: 6000,
    onResult: () => undefined,
    vault,
  });
  if (!tools) throw new Error('tools expected');
  return { created, tools, vault };
}

const sqlError = (message: string, code: string, phase?: 'validation') =>
  Object.assign(new Error(message), { code, ...(phase ? { phase } : {}) });

beforeEach(() => {
  fake = new FakePgGateway();
  n = 0;
  service = new DatabaseService({
    repo: new MemoryDatabaseRepository(),
    gateway: fake,
    clock: new FakeClock(),
    ids: { next: () => `id-${++n}` },
    rules: new MemoryColumnRuleRepository(),
  });
});

describe('checking the SQL of an answer without running it', () => {
  it('confirms a valid query with EXPLAIN only: no query ever reaches the database', async () => {
    const { tools } = await setup();
    const out = await tools.validateSql('select c.z01_nome from public.cgm c limit 5');
    expect(out.validation).toEqual({ status: 'ok', issues: [], reason: null });
    expect(out.aiText).toBeNull();
    expect(fake.explainedOnly).toEqual(['select c.z01_nome from public.cgm c limit 5']);
    expect(fake.queries).toEqual([]);
    expect(fake.explained).toEqual([]);
  });

  it('restores privacy tokens for the database and keeps them in what the model reads', async () => {
    const { tools, vault } = await setup();
    const token = vault.tokenFor('CPF', '10123456760');
    const out = await tools.validateSql(
      `select c.z01_nomee from cgm c where c.z01_cgccpf = '${token}'`,
    );
    // the unknown column is found statically (tokens never reach the message)…
    expect(out.validation.status).toBe('invalid');
    expect(fake.queries).toEqual([]);

    // …and a valid query is analyzed with the real value restored
    const ok = await tools.validateSql(`select z01_nome from cgm where z01_cgccpf = '${token}'`);
    expect(ok.validation.status).toBe('ok');
    expect(fake.explainedOnly.at(-1)).toContain("'10123456760'");
    expect(fake.explainedOnly.at(-1)).not.toContain(token);
    expect(fake.queries).toEqual([]);
  });

  it('flags an unknown column with suggestions and words it for the model without header or footer', async () => {
    const { tools } = await setup();
    const out = await tools.validateSql('select c.z01_nomee from public.cgm c limit 5');
    expect(out.validation.status).toBe('invalid');
    expect(out.validation.issues).toEqual([
      {
        message: 'coluna "z01_nomee" não existe em public.cgm (usada como c.z01_nomee).',
        suggestions: ['z01_nome', 'z01_nomecomple'],
      },
    ]);
    expect(out.aiText).toContain('Parecidas: z01_nome, z01_nomecomple.');
    expect(out.aiText).not.toContain('nada foi executado');
    expect(out.aiText).not.toContain('executar_consulta');
    // caught by the static check: not even EXPLAIN was needed
    expect(fake.explainedOnly).toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  it('flags an unknown table', async () => {
    const { tools } = await setup();
    const out = await tools.validateSql('select * from contribuinte');
    expect(out.validation.status).toBe('invalid');
    expect(out.validation.issues[0]).toMatchObject({
      message: 'tabela "contribuinte" não existe.',
      suggestions: expect.arrayContaining(['contribuintes']),
    });
  });

  it('turns a name error raised by EXPLAIN (42703/42P01/42702/42883) into suggestions', async () => {
    const { tools } = await setup();
    fake.explainCheck = () => {
      throw sqlError('column "nomee" does not exist', '42703', 'validation');
    };
    const out = await tools.validateSql('select nomee from cgm');
    expect(out.validation.status).toBe('invalid');
    expect(out.validation.issues[0]?.message).toContain('nomee');
    expect(out.aiText).toContain('nomee');
    expect(fake.queries).toEqual([]);
  });

  it('refuses a statement that is not read-only, without contacting the database', async () => {
    const { tools } = await setup();
    const out = await tools.validateSql('delete from cgm');
    expect(out.validation.status).toBe('invalid');
    expect(out.validation.issues[0]?.message).toContain('Consulta recusada');
    expect(out.aiText).toBeNull();
    expect(fake.snapshotCalls).toBe(0);
    expect(fake.explainedOnly).toEqual([]);
  });

  it('treats other planner errors by kind: syntax is invalid, placeholders are unchecked', async () => {
    const { tools } = await setup();
    fake.explainCheck = () => {
      throw sqlError('syntax error at or near "from"', '42601');
    };
    const syntax = await tools.validateSql('select from cgm');
    expect(syntax.validation.status).toBe('invalid');
    expect(syntax.aiText).toBeNull();

    fake.explainCheck = () => {
      throw sqlError('there is no parameter $1', '42P02');
    };
    const param = await tools.validateSql('select * from cgm where id = $1');
    expect(param.validation.status).toBe('unchecked');
    expect(param.validation.reason).toContain('parâmetros');

    fake.explainCheck = () => {
      throw sqlError('canceling statement due to statement timeout', '57014');
    };
    const slow = await tools.validateSql('select * from cgm');
    expect(slow.validation.status).toBe('unchecked');
  });

  it('reports an unreachable database as unchecked and does not retry for the rest of the turn', async () => {
    const { tools } = await setup();
    fake.unreachable = sqlError('connect ECONNREFUSED 10.0.0.1:5432', 'ECONNREFUSED');
    const first = await tools.validateSql('select * from cgm');
    expect(first.validation.status).toBe('unchecked');
    expect(first.validation.reason).toContain('Conexão recusada em db.local:5432');
    expect(first.unreachable).toBe(true);

    fake.unreachable = null;
    const second = await tools.validateSql('select * from cgm');
    expect(second.validation).toMatchObject({ status: 'unchecked' });
    expect(second.validation.reason).toBe(first.validation.reason);
    expect(fake.explainedOnly).toEqual([]);
  });

  it('only statically checks an EXPLAIN statement (an EXPLAIN of an EXPLAIN is a syntax error)', async () => {
    const { tools } = await setup();
    const out = await tools.validateSql('explain select * from cgm');
    expect(out.validation.status).toBe('ok');
    expect(fake.explainedOnly).toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  it('service.validate (POST /validate) uses the analyst scope and never executes', async () => {
    const { created } = await setup();
    const ok = await service.validate(created.id, 'select 1 from cgm limit 1');
    expect(ok).toEqual({ status: 'ok', issues: [], reason: null });
    const bad = await service.validate(created.id, 'select c.z01_xyz from public.cgm c');
    expect(bad.status).toBe('invalid');
    expect(fake.queries).toEqual([]);
    await expect(service.validate('nope', 'select 1')).rejects.toThrow();
  });
});
