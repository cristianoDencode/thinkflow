import type { TestDefinition, TestLocator, TestStep, TestStepValue } from '@thinkflow/shared';
import type { TestSession } from './session';

/** A JS string literal (safe for any recorded text). */
const str = (s: string) => JSON.stringify(s);
const regex = (s: string) => `new RegExp(${str(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`;

/** `TF_SENHA` for the recorded set, `TF_SENHA_2`, `TF_SENHA_3`… for the others (falling back). */
export function secretEnvName(paramName: string, dataSetIndex: number): string {
  const base = `TF_${paramName.toUpperCase()}`;
  return dataSetIndex === 0 ? base : `${base}_${dataSetIndex + 1}`;
}

function locatorCode(scope: string, l: TestLocator): string {
  switch (l.kind) {
    case 'testid':
      return `${scope}.getByTestId(${str(l.value)})`;
    case 'role':
      return `${scope}.getByRole(${str(l.role)}, { name: ${str(l.name)}, exact: true })`;
    case 'label':
      return `${scope}.getByLabel(${str(l.text)}, { exact: true })`;
    case 'placeholder':
      return `${scope}.getByPlaceholder(${str(l.text)}, { exact: true })`;
    case 'alt':
      return `${scope}.getByAltText(${str(l.text)}, { exact: true })`;
    case 'title':
      return `${scope}.getByTitle(${str(l.text)}, { exact: true })`;
    case 'text':
      return `${scope}.getByText(${str(l.text)}, { exact: true })`;
    case 'css':
      return `${scope}.locator(${str(l.selector)})`;
  }
}

function target(step: TestStep): string {
  const t = step.target!;
  const scope = t.frameUrl
    ? `(page.frame({ url: ${str(t.frameUrl)} }) ?? page.mainFrame())`
    : 'page';
  return locatorCode(scope, t.locators[0]!);
}

function valueCode(def: TestDefinition, value: TestStepValue): string {
  if ('literal' in value) return str(value.literal);
  const param = def.parameters.find((p) => p.id === value.param);
  return param ? `dados.${param.name}` : str('');
}

/** 1-based position of a checkpoint among the checkpoints of the session (file name of its print). */
function checkpointNumber(def: TestDefinition, step: TestStep): string {
  const n = def.steps.filter((s) => s.kind === 'checkpoint').findIndex((s) => s.id === step.id);
  return String(n + 1).padStart(2, '0');
}

function stepCode(def: TestDefinition, step: TestStep): string[] {
  const lines: string[] = [];
  // custom title typed by the user: shown as a comment; the generated description stays below
  if (step.title?.trim() && step.kind !== 'note' && step.kind !== 'usecase')
    lines.push(`// ${step.title.trim().replace(/\r?\n/g, ' ')}`);
  if (step.target) {
    const alternatives = step.target.locators.slice(1).map((l) => locatorCode('page', l));
    lines.push(`// ${step.target.description.replace(/\r?\n/g, ' ')}`);
    if (alternatives.length) lines.push(`// alternativas: ${alternatives.join(' | ')}`);
  }
  if (step.comment && step.kind !== 'note') lines.push(`// ${step.comment.replace(/\r?\n/g, ' ')}`);
  switch (step.kind) {
    case 'usecase':
      return [`// Caso de uso: ${(step.useCase?.title ?? '').replace(/\r?\n/g, ' ')}`];
    case 'note':
      return [`// Anotação: ${(step.comment ?? '').replace(/\r?\n/g, ' ')}`];
    case 'capture':
      // a print for the document: nothing to replay
      return [
        `// Print da tela${step.page?.title ? `: ${step.page.title.replace(/\r?\n/g, ' ')}` : ''}`,
        ...(step.comment ? [`// ${step.comment.replace(/\r?\n/g, ' ')}`] : []),
      ];
    case 'checkpoint':
      // "Verificar": a print of the whole screen at this moment (kept under test-results/)
      lines.push(
        `// Verificação${step.page?.title ? `: ${step.page.title.replace(/\r?\n/g, ' ')}` : ''}`,
        `await page.screenshot({ path: ${str(`test-results/verificacao-${checkpointNumber(def, step)}.png`)}, fullPage: true });`,
      );
      break;
    case 'goto':
      lines.push(`await page.goto(${str(step.url!)});`);
      break;
    case 'click':
      lines.push(`await ${target(step)}.click();`);
      break;
    case 'dblclick':
      lines.push(`await ${target(step)}.dblclick();`);
      break;
    case 'fill':
      lines.push(`await ${target(step)}.fill(${valueCode(def, step.value!)});`);
      break;
    case 'select':
      lines.push(`await ${target(step)}.selectOption({ label: ${valueCode(def, step.value!)} });`);
      break;
    case 'check':
      lines.push(`await ${target(step)}.check();`);
      break;
    case 'uncheck':
      lines.push(`await ${target(step)}.uncheck();`);
      break;
    case 'press':
      lines.push(
        step.target
          ? `await ${target(step)}.press(${str(step.key!)});`
          : `await page.keyboard.press(${str(step.key!)});`,
      );
      break;
    case 'assert': {
      const a = step.assertion!;
      if (a.type === 'textVisible')
        lines.push(`await expect(page.getByText(${str(a.text)}).first()).toBeVisible();`);
      else if (a.type === 'urlContains')
        lines.push(`await expect(page).toHaveURL(${regex(a.text)});`);
      else if (a.type === 'title') lines.push(`await expect(page).toHaveTitle(${regex(a.text)});`);
      else if (a.type === 'visible') lines.push(`await expect(${target(step)}).toBeVisible();`);
      else {
        const isSelect = step.target!.locators.some(
          (l) => l.kind === 'role' && l.role === 'combobox',
        );
        lines.push(
          isSelect
            ? `await expect(${target(step)}.locator('option:checked')).toHaveText(${valueCode(def, a.value)});`
            : `await expect(${target(step)}).toHaveValue(${valueCode(def, a.value)});`,
        );
      }
      break;
    }
  }
  return lines;
}

/**
 * A data-driven Playwright test (`@playwright/test`): one `test` per data set. Uses the best
 * recorded locator of each step (the others go in a comment); secrets come from environment
 * variables and never appear in the file.
 */
export function generatePlaywrightSpec(session: TestSession, generatedAt: string): string {
  const def = session.definition;
  const secrets = def.parameters.filter((p) => p.secret);
  const rows = def.dataSets.map((ds, i) => {
    const fields = def.parameters.map((p) => {
      if (p.secret) {
        const own = secretEnvName(p.name, i);
        const fallback = secretEnvName(p.name, 0);
        return `${p.name}: process.env.${own}${i > 0 ? ` ?? process.env.${fallback}` : ''} ?? ''`;
      }
      const v = ds.values[p.id] ?? def.dataSets[0]!.values[p.id];
      return `${p.name}: ${str(typeof v === 'string' ? v : '')}`;
    });
    return `  { conjunto: ${str(ds.name)}${fields.length ? `, ${fields.join(', ')}` : ''} },`;
  });
  const body = def.steps.flatMap((s) => stepCode(def, s)).map((l) => `    ${l}`);
  const header = [
    `// Gerado pelo Thinkflow em ${generatedAt} a partir da sessão de teste ${str(session.name)}.`,
    '// Rode com: npx playwright test <arquivo>',
  ];
  if (secrets.length) {
    header.push(
      `// Dados sigilosos vêm de variáveis de ambiente: ${secrets
        .map((p) => secretEnvName(p.name, 0))
        .join(', ')} (e _2, _3… por conjunto).`,
    );
  }
  return [
    ...header,
    "import { expect, test } from '@playwright/test';",
    '',
    'const conjuntos = [',
    ...rows,
    '];',
    '',
    `test.use({ viewport: { width: ${def.viewport.width}, height: ${def.viewport.height} } });`,
    '',
    'for (const dados of conjuntos) {',
    `  test(${str(`${session.name} — `)} + dados.conjunto, async ({ page }) => {`,
    ...body,
    '  });',
    '}',
    '',
  ].join('\n');
}
