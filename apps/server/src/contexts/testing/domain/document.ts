import { RUN_STATUS_LABELS, SECRET_MASK, stepTitle, type TestStepResult } from '@thinkflow/shared';
import type { TestEvidence, TestRun, TestSession } from './session';

export interface DocImage {
  /** Object key in the `tests/` namespace. */
  key: string;
  /** Path inside the zip / markdown (`imagens/passo-03.png`). */
  file: string;
  alt: string;
  mime: 'image/png' | 'image/jpeg';
}

export interface DocStep {
  n: number;
  title: string;
  comment: string | null;
  isNote: boolean;
  /** The step's print, when it goes into the document. */
  image: DocImage | null;
  /** The comment written on the print in the editor. */
  imageComment: string;
  result: TestStepResult['status'] | null;
  error: string | null;
}

export interface EvidenceDocument {
  title: string;
  meta: [string, string][];
  dataSetName: string;
  data: [string, string][];
  steps: DocStep[];
  images: DocImage[];
}

const two = (n: number) => String(n).padStart(2, '0');

/** Prints migrated from the old automatic thumbnails are JPEG; everything else is PNG. */
const mimeOf = (key: string): DocImage['mime'] =>
  /\.jpe?g$/i.test(key) ? 'image/jpeg' : 'image/png';

/**
 * The evidence document, in the order things happened: each step with its comment and its print
 * (annotated when it was edited), when the print is set to be included. Notes are plain text.
 * Secret values are masked.
 */
export function buildEvidenceDocument(input: {
  session: TestSession;
  /** The step images (`test_evidences`), at most one per step. */
  evidences: TestEvidence[];
  lastRun: TestRun | null;
  formatDate: (ms: number) => string;
  now: number;
}): EvidenceDocument {
  const { session, lastRun, formatDate } = input;
  const def = session.definition;
  const images: DocImage[] = [];
  const results = new Map((lastRun?.results ?? []).map((r) => [r.stepId, r]));
  const byStep = new Map(input.evidences.map((e) => [e.stepId, e]));

  let n = 0;
  const steps: DocStep[] = def.steps.map((step) => {
    const isNote = step.kind === 'note' || step.kind === 'usecase';
    if (!isNote) n++;
    const evidence = isNote ? undefined : byStep.get(step.id);
    let image: DocImage | null = null;
    if (evidence?.include) {
      const key = evidence.annotatedKey ?? evidence.originalKey;
      const mime = mimeOf(key);
      image = {
        key,
        file: `imagens/passo-${two(n)}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`,
        alt: `Passo ${n}`,
        mime,
      };
      images.push(image);
    }
    const result = results.get(step.id);
    return {
      n,
      title:
        step.kind === 'usecase'
          ? stepTitle(def, step)
          : isNote
            ? (step.comment ?? '')
            : stepTitle(def, step),
      comment: isNote ? null : step.comment,
      isNote,
      image,
      imageComment: image ? (evidence?.comment ?? '') : '',
      result: isNote || step.kind === 'capture' ? null : (result?.status ?? null),
      error: result?.error ?? null,
    };
  });

  const dataSet = def.dataSets.find((d) => d.id === lastRun?.dataSetId) ?? def.dataSets[0]!;
  const data = def.parameters.map((p): [string, string] => {
    if (p.secret) return [p.label, SECRET_MASK];
    const v = dataSet.values[p.id] ?? def.dataSets[0]!.values[p.id];
    return [p.label, typeof v === 'string' ? v : SECRET_MASK];
  });

  const meta: [string, string][] = [
    ['URL inicial', session.startUrl],
    ['Gerado em', formatDate(input.now)],
    ['Passos', String(n)],
    ['Prints', String(images.length)],
  ];
  if (lastRun) {
    meta.push([
      'Última execução',
      `${RUN_STATUS_LABELS[lastRun.status]} — ${dataSet.name}${lastRun.finishedAt ? `, ${formatDate(lastRun.finishedAt)}` : ''}`,
    ]);
  }
  return {
    title: `Evidência de teste — ${session.name}`,
    meta,
    dataSetName: dataSet.name,
    data,
    steps,
    images,
  };
}

/** Markdown table cells cannot hold `|` or line breaks. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
/** Inline text: no accidental markdown from recorded labels. */
const md = (s: string) => s.replace(/([\\`*_[\]<>])/g, '\\$1');

const RESULT_MARK = { passed: '✔', failed: '✖', skipped: '–' } as const;

/** `src(image)`: relative path (zip) or data URI (clipboard). */
export function renderMarkdown(doc: EvidenceDocument, src: (img: DocImage) => string): string {
  const out: string[] = [`# ${md(doc.title)}`, '', '| Campo | Valor |', '| --- | --- |'];
  for (const [k, v] of doc.meta) out.push(`| ${cell(k)} | ${cell(v)} |`);
  if (doc.data.length) {
    out.push(
      '',
      `## Dados utilizados (${md(doc.dataSetName)})`,
      '',
      '| Dado | Valor |',
      '| --- | --- |',
    );
    for (const [k, v] of doc.data) out.push(`| ${cell(k)} | ${cell(v) || ' '} |`);
  }
  out.push('', '## Passo a passo', '');
  for (const step of doc.steps) {
    if (step.isNote) {
      out.push(`> ${md(step.title)}`, '');
      continue;
    }
    const mark = step.result ? `${RESULT_MARK[step.result]} ` : '';
    out.push(`${step.n}. ${mark}${md(step.title)}`);
    if (step.error) out.push(`   - **Falha:** ${md(step.error)}`);
    if (step.comment) out.push(`   - ${md(step.comment)}`);
    if (step.image) {
      out.push('', `   ![${step.image.alt}](${src(step.image)})`);
      if (step.imageComment) out.push('', `   *${md(step.imageComment)}*`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Simple, inline-styled HTML that survives a paste into Word, Google Docs and Confluence (no
 * classes, no scripts; images as data URIs, at most 640 px wide).
 */
export function renderHtml(doc: EvidenceDocument, src: (img: DocImage) => string): string {
  const td = 'border:1px solid #cbd5e1;padding:4px 8px;text-align:left;vertical-align:top';
  const table = (rows: [string, string][], head: [string, string]) =>
    `<table style="border-collapse:collapse;margin:8px 0"><tr><th style="${td};background:#f1f5f9">${esc(head[0])}</th><th style="${td};background:#f1f5f9">${esc(head[1])}</th></tr>${rows
      .map(([k, v]) => `<tr><td style="${td}">${esc(k)}</td><td style="${td}">${esc(v)}</td></tr>`)
      .join('')}</table>`;
  const img = (i: DocImage) =>
    `<p><img src="${esc(src(i))}" alt="${esc(i.alt)}" width="640" style="max-width:100%;border:1px solid #cbd5e1"></p>`;
  const color = { passed: '#15803d', failed: '#b91c1c', skipped: '#64748b' } as const;
  const parts = [`<h1>${esc(doc.title)}</h1>`, table(doc.meta, ['Campo', 'Valor'])];
  if (doc.data.length) {
    parts.push(
      `<h2>Dados utilizados (${esc(doc.dataSetName)})</h2>`,
      table(doc.data, ['Dado', 'Valor']),
    );
  }
  parts.push('<h2>Passo a passo</h2>');
  for (const step of doc.steps) {
    if (step.isNote) {
      parts.push(
        `<p style="border-left:3px solid #cbd5e1;padding-left:8px;color:#475569"><i>${esc(step.title)}</i></p>`,
      );
      continue;
    }
    const mark = step.result
      ? `<span style="color:${color[step.result]}">${RESULT_MARK[step.result]}</span> `
      : '';
    parts.push(`<p><b>${step.n}.</b> ${mark}${esc(step.title)}</p>`);
    if (step.error)
      parts.push(`<p style="color:#b91c1c;margin-left:16px"><b>Falha:</b> ${esc(step.error)}</p>`);
    if (step.comment) parts.push(`<p style="margin-left:16px">${esc(step.comment)}</p>`);
    if (step.image) {
      parts.push(img(step.image));
      if (step.imageComment)
        parts.push(`<p style="margin-left:16px"><i>${esc(step.imageComment)}</i></p>`);
    }
  }
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(doc.title)}</title></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#0f172a">${parts.join('')}</body></html>`;
}
