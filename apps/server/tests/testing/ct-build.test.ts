import { stepSchema, type TestStep } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCtDocument,
  ctPlanoPlainText,
  ctStateDocument,
  resolveCtFields,
} from '../../src/contexts/testing/domain/ct-build';
import { imageSize } from '../../src/contexts/testing/domain/image-size';
import {
  newDefinition,
  type TestEvidence,
  type TestSession,
} from '../../src/contexts/testing/domain/session';
import { makePng } from './ct/ct-fixtures';

const NOW = new Date('2026-11-12T15:00:00Z');

function step(id: string, comment: string | null, extra: Record<string, unknown> = {}): TestStep {
  return stepSchema.parse({
    id,
    at: 1,
    kind: 'click',
    target: {
      locators: [{ kind: 'css', selector: '#a' }],
      description: 'botão',
      bbox: null,
      frameUrl: null,
    },
    comment,
    ...extra,
  });
}
const divider = (id: string, title = '', status = 'Finalizado'): TestStep =>
  stepSchema.parse({ id, at: 1, kind: 'usecase', useCase: { title, status } });

function evidence(stepId: string, over: Partial<TestEvidence> = {}): TestEvidence {
  return {
    id: `e-${stepId}`,
    sessionId: 's1',
    stepId,
    seq: 1,
    at: 1,
    width: 100,
    height: 50,
    originalKey: `s1/evidences/e-${stepId}/original.png`,
    annotatedKey: null,
    annotations: [],
    crop: null,
    comment: '',
    include: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function session(steps: TestStep[], ct?: TestSession['definition']['ct']): TestSession {
  return {
    id: 's1',
    name: 'Cálculo da taxa',
    startUrl: 'https://a.b/',
    definition: { ...newDefinition({ mode: 'record' }), steps, ...(ct ? { ct } : {}) },
    secrets: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

const sizes = (...keys: string[]) =>
  new Map(keys.map((k) => [k, { width: 200, height: 100 }] as const));

function build(s: TestSession, evidences: TestEvidence[], keys: string[]) {
  const fields = resolveCtFields(s, 'Ana Souza', NOW);
  return buildCtDocument({ session: s, fields, evidences, imageSizes: sizes(...keys) });
}

describe('resolveCtFields', () => {
  it('fills the defaults of a session that never saved the CT', () => {
    const fields = resolveCtFields(session([]), 'Ana Souza', NOW);
    expect(fields).toMatchObject({
      title: 'Cálculo da taxa',
      ticketId: '',
      priority: 'Normal',
      author: 'Ana Souza',
      analysisTitle: 'Análise',
      context: '',
    });
    expect(fields.versions).toEqual([
      {
        version: '1.0',
        date: '12/11/2026',
        description: 'Criação do documento',
        author: 'Ana Souza',
      },
    ]);
  });

  it('keeps what was saved', () => {
    const fields = resolveCtFields(
      session([], {
        title: 'Outro título',
        priority: 'Urgente',
        author: 'Bia',
        analysisTitle: 'Descrição da Demanda',
        versions: [{ version: '2.0', date: '01/01/2026', description: 'Ajuste', author: 'Bia' }],
      }),
      'Ana Souza',
      NOW,
    );
    expect(fields).toMatchObject({
      title: 'Outro título',
      priority: 'Urgente',
      author: 'Bia',
      analysisTitle: 'Descrição da Demanda',
    });
    expect(fields.versions).toHaveLength(1);
    expect(fields.versions[0]!.version).toBe('2.0');
  });
});

describe('buildCtDocument', () => {
  it('puts every step in "Caso de Uso 1" by default: comment first, then the print', () => {
    const steps = [step('a', 'Abre a tela'), step('b', null), step('c', null)];
    const evs = [
      evidence('a'),
      evidence('b', { include: false }),
      evidence('c', { comment: 'Resultado' }),
    ];
    const { document, itemStepIds, useCases } = build(session(steps), evs, [
      evs[0]!.originalKey,
      evs[2]!.originalKey,
    ]);
    expect(document.useCases).toHaveLength(1);
    expect(document.useCases[0]!.title).toBeUndefined();
    expect(document.useCases[0]!.items.map((i) => i.kind)).toEqual(['text', 'image', 'image']);
    expect(document.useCases[0]!.items[2]).toMatchObject({ kind: 'image', caption: 'Resultado' });
    // step b has neither comment nor included print: omitted
    expect(itemStepIds).toEqual([['a', 'a', 'c']]);
    expect(useCases).toEqual([
      { stepId: null, title: '', defaultTitle: 'Caso de Uso 1', status: 'Finalizado' },
    ]);
  });

  it('uses the annotated (cropped) image and its real size', () => {
    const steps = [step('a', null)];
    const ev = evidence('a', { annotatedKey: 's1/evidences/e-a/annotated.png' });
    const { document } = buildCtDocument({
      session: session(steps),
      fields: resolveCtFields(session(steps), '', NOW),
      evidences: [ev],
      imageSizes: new Map([['s1/evidences/e-a/annotated.png', { width: 640, height: 200 }]]),
    });
    expect(document.useCases[0]!.items).toEqual([
      { kind: 'image', key: 's1/evidences/e-a/annotated.png', width: 640, height: 200 },
    ]);
  });

  it('splits use cases at the dividers, with titles and statuses', () => {
    const steps = [
      step('a', 'Antes'),
      divider('d1', 'Cálculo', 'Reprovado'),
      step('b', 'Dentro'),
      divider('d2'),
      step('c', 'Fim'),
    ];
    const { document, useCases } = build(session(steps), [], []);
    expect(document.useCases.map((u) => [u.title, u.status, u.items.length])).toEqual([
      [undefined, 'Finalizado', 1],
      ['Cálculo', 'Reprovado', 1],
      [undefined, 'Finalizado', 1],
    ]);
    expect(useCases.map((u) => [u.stepId, u.defaultTitle])).toEqual([
      [null, 'Caso de Uso 1'],
      ['d1', 'Caso de Uso 2'],
      ['d2', 'Caso de Uso 3'],
    ]);
  });

  it('drops the implicit first use case when nothing in it reaches the document', () => {
    const steps = [step('a', null), divider('d1', 'Cálculo'), step('b', 'x')];
    const { document, useCases } = build(session(steps), [], []);
    expect(document.useCases).toHaveLength(1);
    expect(useCases.map((u) => u.stepId)).toEqual(['d1']);
  });

  it('renders a comment marked as code as a code item and keeps its line breaks', () => {
    const steps = [step('a', '\n  SELECT *\n    FROM t  \n', { commentIsCode: true })];
    const { document } = build(session(steps), [], []);
    expect(document.useCases[0]!.items).toEqual([{ kind: 'code', text: '  SELECT *\n    FROM t' }]);
  });

  it('uses the stored title and status of the implicit use case', () => {
    const steps = [step('a', 'x')];
    const { document } = build(
      session(steps, { firstUseCase: { title: 'Primeiro', status: 'Pendente' } }),
      [],
      [],
    );
    expect(document.useCases[0]).toMatchObject({ title: 'Primeiro', status: 'Pendente' });
  });

  it('counts prints that are gone from the storage and leaves them out', () => {
    const steps = [step('a', 'Texto')];
    const { document, missingImages } = build(session(steps), [evidence('a')], []);
    expect(missingImages).toBe(1);
    expect(document.useCases[0]!.items.map((i) => i.kind)).toEqual(['text']);
  });

  it('feeds the AI assistant text and image markers only', () => {
    const steps = [step('a', 'Texto'), step('b', 'SELECT 1', { commentIsCode: true })];
    const ev = evidence('b');
    const doc = build(session(steps), [ev], [ev.originalKey]).document;
    expect(ctStateDocument(doc).useCases[0]!.items).toEqual([
      { kind: 'text', text: 'Texto' },
      { kind: 'code', text: 'SELECT 1' },
      { kind: 'image' },
    ]);
  });

  it('has a plain-text version of the plano', () => {
    const steps = [step('a', 'Abre a tela'), divider('d', 'Cálculo', 'Pendente'), step('b', null)];
    const ev = evidence('b');
    const doc = build(session(steps), [ev], [ev.originalKey]).document;
    expect(ctPlanoPlainText(doc)).toBe(
      'Caso de Uso 1 — Finalizado\nAbre a tela\n\nCálculo — Pendente\n[imagem]\n',
    );
  });
});

describe('imageSize', () => {
  it('reads PNG, JPEG and GIF headers', () => {
    expect(imageSize(makePng(321, 123))).toEqual({ width: 321, height: 123 });
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x32, 0x00, 0x64, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 100, height: 50 });
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x14, 0x00, 0]);
    expect(imageSize(gif)).toEqual({ width: 10, height: 20 });
    expect(imageSize(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});
