import { describe, expect, it } from 'vitest';
import type { TestDefinition } from '@thinkflow/shared';
import {
  buildEvidenceDocument,
  renderHtml,
  renderMarkdown,
} from '../../src/contexts/testing/domain/document';
import {
  newDefinition,
  type TestEvidence,
  type TestSession,
} from '../../src/contexts/testing/domain/session';
import { generatePlaywrightSpec, secretEnvName } from '../../src/contexts/testing/domain/spec';

const base = { page: null, comment: null } as const;
const tgt = (
  description: string,
  locators: NonNullable<TestDefinition['steps'][number]['target']>['locators'],
) => ({
  locators,
  description,
  bbox: null,
  frameUrl: null,
});

function session(): TestSession {
  const definition: TestDefinition = {
    ...newDefinition({}),
    parameters: [
      { id: 'p1', name: 'email', label: 'E-mail', type: 'text', secret: false },
      { id: 'p2', name: 'senha', label: 'Senha', type: 'password', secret: true },
    ],
    dataSets: [
      { id: 'recorded', name: 'Gravado', values: { p1: 'ana@x.com', p2: { $secret: true } } },
      { id: 'd2', name: 'E-mail inválido', values: { p1: 'ana@' } },
    ],
    steps: [
      {
        ...base,
        id: 's1',
        at: 1,
        kind: 'goto',
        url: 'https://a.b/login',
        target: null,
      },
      { ...base, id: 'n1', at: 2, kind: 'note', comment: 'Usuário já cadastrado', target: null },
      {
        ...base,
        id: 's2',
        at: 3,
        kind: 'fill',
        value: { param: 'p1' },
        comment: 'Campo | principal',
        target: tgt('campo "E-mail"', [
          { kind: 'role', role: 'textbox', name: 'E-mail' },
          { kind: 'css', selector: '#email' },
        ]),
      },
      {
        ...base,
        id: 's3',
        at: 4,
        kind: 'fill',
        value: { param: 'p2' },
        target: tgt('campo "Senha"', [{ kind: 'label', text: 'Senha' }]),
      },
      {
        ...base,
        id: 's4',
        at: 5,
        kind: 'click',
        target: tgt('botão "Entrar"', [{ kind: 'testid', value: 'entrar' }]),
      },
      {
        ...base,
        id: 's5',
        at: 6,
        kind: 'assert',
        assertion: { type: 'textVisible', text: 'Bem-vinda' },
        target: null,
      },
      {
        ...base,
        id: 's6',
        at: 7,
        kind: 'assert',
        assertion: { type: 'value', value: { param: 'p1' } },
        target: tgt('campo "E-mail"', [{ kind: 'role', role: 'textbox', name: 'E-mail' }]),
      },
      {
        ...base,
        id: 's7',
        at: 8,
        kind: 'assert',
        assertion: { type: 'urlContains', text: '/painel?x=1' },
        target: null,
      },
      {
        ...base,
        id: 'c1',
        at: 9,
        kind: 'capture',
        page: { url: 'https://a.b/painel', title: 'Painel' },
        target: null,
      },
    ],
  };
  return {
    id: 'S',
    name: 'Login <admin>',
    startUrl: 'https://a.b/login',
    definition,
    secrets: { recorded: { p2: 'segredo-123' } },
    createdAt: 1,
    updatedAt: 1,
  };
}

const evidence = (over: Partial<TestEvidence>): TestEvidence => ({
  id: 'e',
  sessionId: 'S',
  stepId: 's1',
  seq: 1,
  at: 1,
  width: 10,
  height: 10,
  originalKey: 'S/evidences/e/original.png',
  annotatedKey: null,
  annotations: [],
  crop: null,
  comment: '',
  include: true,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function doc(lastRun = null as Parameters<typeof buildEvidenceDocument>[0]['lastRun']) {
  return buildEvidenceDocument({
    session: session(),
    evidences: [
      // a migrated thumbnail (JPEG) on the first step, left in the document
      evidence({ id: 'e0', seq: 1, stepId: 's1', originalKey: 'S/steps/s1.jpg' }),
      // an annotated print: the annotated render is what goes into the document
      evidence({
        id: 'e2',
        seq: 2,
        stepId: 's4',
        annotatedKey: 'S/evidences/e2/annotated.png',
        comment: 'Tela após entrar',
      }),
      // left out of the document
      evidence({ id: 'e3', seq: 3, stepId: 's3', include: false }),
      // the print of a manual capture step
      evidence({ id: 'e4', seq: 4, stepId: 'c1', comment: 'Sistema legado' }),
      // a note never has an image
      evidence({ id: 'e5', seq: 5, stepId: 'n1' }),
    ],
    lastRun,
    formatDate: () => '11/11/2026 19:00',
    now: 0,
  });
}

describe('evidence document', () => {
  it('follows the steps in order, with notes and the included step images', () => {
    const d = doc();
    expect(d.title).toBe('Evidência de teste — Login <admin>');
    expect(d.steps.map((s) => [s.n, s.isNote, s.title])).toEqual([
      [1, false, 'Abrir https://a.b/login'],
      [1, true, 'Usuário já cadastrado'],
      [2, false, 'Preencher campo "E-mail" com "ana@x.com"'],
      [3, false, 'Preencher campo "Senha" com "••••••"'],
      [4, false, 'Clicar botão "Entrar"'],
      [5, false, 'Verificar: texto visível "Bem-vinda"'],
      [6, false, 'Verificar: campo "E-mail" = "ana@x.com"'],
      [7, false, 'Verificar: url contém "/painel?x=1"'],
      [8, false, 'Print da tela: Painel'],
    ]);
    // the format follows the stored file: migrated thumbnails are JPEG, prints are PNG
    expect(d.steps[0]!.image).toMatchObject({
      key: 'S/steps/s1.jpg',
      file: 'imagens/passo-01.jpg',
      mime: 'image/jpeg',
    });
    expect(d.steps[4]!.image).toMatchObject({
      key: 'S/evidences/e2/annotated.png',
      file: 'imagens/passo-04.png',
      mime: 'image/png',
    });
    expect(d.steps[4]!.imageComment).toBe('Tela após entrar');
    expect(d.steps[3]!.image).toBeNull(); // include = false
    expect(d.steps[1]!.image).toBeNull(); // notes carry no image
    expect(d.steps[8]!.image).toMatchObject({ file: 'imagens/passo-08.png', alt: 'Passo 8' });
    expect(d.steps[8]!.imageComment).toBe('Sistema legado');
    expect(d.steps[8]!.result).toBeNull();
    expect(d.images.map((i) => i.file)).toEqual([
      'imagens/passo-01.jpg',
      'imagens/passo-04.png',
      'imagens/passo-08.png',
    ]);
    expect(d.meta).toContainEqual(['Prints', '3']);
    expect(d.data).toEqual([
      ['E-mail', 'ana@x.com'],
      ['Senha', '••••••'],
    ]);
  });

  it('shows the last run: its data set, marks and the failure', () => {
    const d = doc({
      id: 'r',
      sessionId: 'S',
      seq: 1,
      rerunOf: null,
      snapshot: null,
      dataSetId: 'd2',
      status: 'failed',
      headed: false,
      results: [
        {
          stepId: 's1',
          status: 'passed',
          durationMs: 1,
          error: null,
          locatorUsed: null,
          screenshotKey: null,
        },
        {
          stepId: 's5',
          status: 'failed',
          durationMs: 1,
          error: 'Texto não encontrado',
          locatorUsed: null,
          screenshotKey: null,
        },
        {
          stepId: 'c1',
          status: 'skipped',
          durationMs: 0,
          error: null,
          locatorUsed: null,
          screenshotKey: null,
        },
      ],
      error: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
    });
    expect(d.dataSetName).toBe('E-mail inválido');
    expect(d.data[0]).toEqual(['E-mail', 'ana@']);
    expect(d.meta.at(-1)).toEqual([
      'Última execução',
      'Falhou — E-mail inválido, 11/11/2026 19:00',
    ]);
    const md = renderMarkdown(d, (i) => i.file);
    expect(md).toContain('1. ✔ Abrir https://a.b/login');
    expect(md).toContain('5. ✖ Verificar: texto visível "Bem-vinda"');
    expect(md).toContain('   - **Falha:** Texto não encontrado');
    // a print is neither passed nor failed
    expect(md).toContain('8. Print da tela: Painel');
  });

  it('renders markdown and Word-friendly HTML without leaking secrets or markup', () => {
    const d = doc();
    const md = renderMarkdown(d, (i) => i.file);
    expect(md).toContain('# Evidência de teste — Login \\<admin\\>');
    expect(md).toContain('> Usuário já cadastrado');
    expect(md).toContain('   ![Passo 4](imagens/passo-04.png)');
    expect(md).toContain('   *Tela após entrar*');
    expect(md).not.toContain('Outras evidências');
    const html = renderHtml(d, (i) => `data:${i.mime};base64,AAAA`);
    expect(html).toContain('<h1>Evidência de teste — Login &lt;admin&gt;</h1>');
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="Passo 4" width="640"');
    expect(html).toContain('<img src="data:image/jpeg;base64,AAAA" alt="Passo 1" width="640"');
    expect(html).not.toContain('<script');
    for (const out of [md, html]) expect(out).not.toContain('segredo-123');
  });
});

describe('Playwright spec', () => {
  it('writes a screenshot for each checkpoint ("Verificar")', () => {
    const base = session();
    const step = (id: string, comment: string | null) =>
      ({
        id,
        at: 20,
        kind: 'checkpoint',
        target: null,
        page: { url: 'https://a.b/painel', title: 'Painel' },
        comment,
      }) as const;
    const withCheckpoints = {
      ...base,
      definition: {
        ...base.definition,
        steps: [...base.definition.steps, step('k1', 'Saldo exibido'), step('k2', null)],
      },
    };
    const out = generatePlaywrightSpec(withCheckpoints, '11/11/2026 19:00');
    expect(out).toContain('// Verificação: Painel');
    expect(out).toContain('// Saldo exibido');
    expect(out).toContain(
      'await page.screenshot({ path: "test-results/verificacao-01.png", fullPage: true });',
    );
    expect(out).toContain('"test-results/verificacao-02.png"');
    // still valid code
    const body = out.replace("import { expect, test } from '@playwright/test';", '');
    expect(() =>
      new Function('expect', 'test', 'process', body)(
        () => undefined,
        Object.assign(() => undefined, { use: () => undefined }),
        { env: {} },
      ),
    ).not.toThrow();
  });

  const spec = generatePlaywrightSpec(session(), '11/11/2026 19:00');

  it('is valid code (plain JavaScript syntax, so it also runs as TypeScript)', () => {
    const body = spec.replace("import { expect, test } from '@playwright/test';", '');
    // compiles (throws SyntaxError otherwise) and registers one test per data set
    const titles: string[] = [];
    new Function('expect', 'test', 'process', body)(
      () => undefined,
      Object.assign((title: string) => titles.push(title), { use: () => undefined }),
      { env: {} },
    );
    expect(titles).toEqual(['Login <admin> — Gravado', 'Login <admin> — E-mail inválido']);
  });

  it('runs one test per data set, secrets from the environment', () => {
    expect(spec).toContain(
      `{ conjunto: "Gravado", email: "ana@x.com", senha: process.env.TF_SENHA ?? '' },`,
    );
    expect(spec).toContain(
      `{ conjunto: "E-mail inválido", email: "ana@", senha: process.env.TF_SENHA_2 ?? process.env.TF_SENHA ?? '' },`,
    );
    expect(spec).not.toContain('segredo-123');
    expect(spec).toContain('// Dados sigilosos vêm de variáveis de ambiente: TF_SENHA');
    expect(secretEnvName('cpf_titular', 2)).toBe('TF_CPF_TITULAR_3');
  });

  it('uses the best locator, keeps the others as a comment and writes the checks', () => {
    expect(spec).toContain(
      `await page.getByRole("textbox", { name: "E-mail", exact: true }).fill(dados.email);`,
    );
    expect(spec).toContain(`// alternativas: page.locator("#email")`);
    expect(spec).toContain(`// Campo | principal`);
    expect(spec).toContain(`await page.getByTestId("entrar").click();`);
    expect(spec).toContain(`await expect(page.getByText("Bem-vinda").first()).toBeVisible();`);
    expect(spec).toContain(
      `await expect(page.getByRole("textbox", { name: "E-mail", exact: true })).toHaveValue(dados.email);`,
    );
    expect(spec).toContain('await expect(page).toHaveURL(new RegExp("/painel\\\\?x=1"));');
    expect(spec).toContain('// Anotação: Usuário já cadastrado');
    // a print is only a comment: nothing to replay
    expect(spec).toContain('// Print da tela: Painel');
    expect(spec).not.toMatch(/await .*Painel/);
    expect(spec).toContain(`test("Login <admin> — " + dados.conjunto, async ({ page }) => {`);
  });
});
