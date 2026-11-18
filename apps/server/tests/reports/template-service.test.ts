import { describe, expect, it } from 'vitest';
import { TemplateService } from '../../src/contexts/reports/application/template-service';
import { BUILTIN_TEMPLATES } from '../../src/contexts/reports/domain/builtin-templates';
import type { ReportTemplateRepository } from '../../src/contexts/reports/domain/ports';
import type { ReportTemplate, TemplateKind } from '../../src/contexts/reports/domain/template';

class MemoryRepo implements ReportTemplateRepository {
  readonly rows = new Map<string, ReportTemplate>();
  async list(kind?: TemplateKind) {
    return [...this.rows.values()].filter((t) => !kind || t.kind === kind);
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findByName(kind: TemplateKind, name: string) {
    return [...this.rows.values()].find((t) => t.kind === kind && t.name === name) ?? null;
  }
  async save(t: ReportTemplate) {
    this.rows.set(t.id, structuredClone(t));
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async count() {
    return this.rows.size;
  }
}

function setup() {
  const repo = new MemoryRepo();
  let now = 1000;
  let seq = 0;
  const service = new TemplateService({
    repo,
    clock: { now: () => now },
    ids: { next: () => `id-${++seq}` },
  });
  return { repo, service, tick: (to: number) => (now = to) };
}

describe('TemplateService.ensureBuiltIns', () => {
  it('inserts every seed once and is idempotent', async () => {
    const { repo, service, tick } = setup();
    await service.ensureBuiltIns();
    expect(repo.rows.size).toBe(BUILTIN_TEMPLATES.length);
    const before = structuredClone([...repo.rows.values()]);
    tick(5000);
    await service.ensureBuiltIns();
    expect([...repo.rows.values()]).toEqual(before);
  });

  it('upgrades seeds whose stored version is lower, keeping createdAt', async () => {
    const { repo, service, tick } = setup();
    await service.ensureBuiltIns();
    const seed = BUILTIN_TEMPLATES[0]!;
    const stored = repo.rows.get(seed.id)!;
    repo.rows.set(seed.id, { ...stored, builtInVersion: 0, name: 'Velho', description: 'velho' });
    tick(9000);
    await service.ensureBuiltIns();
    expect(repo.rows.get(seed.id)).toMatchObject({
      name: seed.name,
      description: seed.description,
      builtInVersion: seed.builtInVersion,
      builtIn: true,
      createdAt: 1000,
      updatedAt: 9000,
    });
  });

  it('does not downgrade a seed stored with a higher version', async () => {
    const { repo, service } = setup();
    await service.ensureBuiltIns();
    const seed = BUILTIN_TEMPLATES[0]!;
    repo.rows.set(seed.id, { ...repo.rows.get(seed.id)!, builtInVersion: 99, description: 'novo' });
    await service.ensureBuiltIns();
    expect(repo.rows.get(seed.id)?.description).toBe('novo');
  });

  it('renames a user template that already owns a seed name', async () => {
    const { repo, service } = setup();
    const seed = BUILTIN_TEMPLATES[0]!;
    repo.rows.set('mine', {
      id: 'mine',
      name: seed.name,
      kind: seed.kind,
      description: '',
      builtIn: false,
      builtInVersion: null,
      spec: seed.spec,
      createdAt: 1,
      updatedAt: 1,
    });
    await service.ensureBuiltIns();
    expect(repo.rows.get('mine')?.name).toBe(`${seed.name} (cópia)`);
    expect(repo.rows.get(seed.id)?.name).toBe(seed.name);
  });
});
