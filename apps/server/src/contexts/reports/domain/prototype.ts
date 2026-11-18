import type { TemplateLayout } from '@thinkflow/shared';
import type { OAIMessage } from '../../protocol/domain/wire-types';
import { escapeHtml, safeLogo, slugify } from './assembly';
import { extractJsonObject } from './json-extract';
import type { ReportSection } from './report';
import { DATA_NOT_INSTRUCTIONS, personaText, variablesBlock } from './research';
import { CONTENT_SECURITY_POLICY, prototypeCss } from './themes';
import { renderTemplateText, type TemplateSpec } from './template';

export const MAX_SCREENS = 8;
export const SCREEN_PLAN_MAX_TOKENS = 700;
export const SPEC_SCREEN_ID = 'tela-especificacao';

/** The component kit a screen may use (see `prototypeCss`). */
export const PROTOTYPE_KIT = [
  'tf-app',
  'tf-nav',
  'tf-card',
  'tf-btn',
  'tf-btn-primary',
  'tf-input',
  'tf-table',
  'tf-grid',
  'tf-badge',
  'tf-alert',
] as const;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export interface PlannedScreen {
  title: string;
  objective: string;
}

export type ScreenPlanParse = { ok: true; screens: PlannedScreen[] } | { ok: false; error: string };

export function buildScreenPlanMessages(
  spec: TemplateSpec,
  vars: Record<string, string>,
  sectionTitles: string[],
  parseError?: string,
): OAIMessage[] {
  const user = [
    'Planeje as telas do protótipo descrito abaixo.',
    `Objetivo: ${renderTemplateText(spec.objective, vars) || '(não informado)'}`,
    variablesBlock(vars),
    sectionTitles.length
      ? `Seções da especificação:\n${sectionTitles.map((t) => `- ${t}`).join('\n')}`
      : '',
    `Proponha de 1 a ${MAX_SCREENS} telas, cada uma com título curto e o objetivo.`,
    'Responda SOMENTE com JSON, sem texto extra: {"telas":[{"slug":"lista-debitos","titulo":"…","objetivo":"…"}]}',
    parseError
      ? `Sua resposta anterior não pôde ser lida (${parseError}). Responda apenas com o JSON.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: `${personaText(spec, vars)}\n${DATA_NOT_INSTRUCTIONS}` },
    { role: 'user', content: user },
  ];
}

export function parseScreenPlan(answer: string): ScreenPlanParse {
  const json = extractJsonObject(answer);
  if (!json) return { ok: false, error: 'JSON inválido' };
  const raw = json.telas ?? json.screens;
  if (!Array.isArray(raw)) return { ok: false, error: 'campo "telas" ausente' };
  const screens: PlannedScreen[] = [];
  for (const item of raw) {
    if (screens.length >= MAX_SCREENS) break;
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const title = String(entry.titulo ?? entry.title ?? entry.slug ?? '').trim();
    if (!title) continue;
    screens.push({
      title: clip(title.replace(/\s+/g, ' '), 80),
      objective: clip(String(entry.objetivo ?? entry.objective ?? '').trim(), 400),
    });
  }
  return screens.length ? { ok: true, screens } : { ok: false, error: 'nenhuma tela válida' };
}

/** One screen per comma/semicolon/line item of the `telas` variable; "Tela inicial" otherwise. */
export function fallbackScreens(vars: Record<string, string>): PlannedScreen[] {
  const items = (vars.telas ?? '')
    .split(/[,;\n]+/)
    .map((t) => t.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_SCREENS);
  if (items.length === 0) return [{ title: 'Tela inicial', objective: '' }];
  return items.map((title) => ({ title: clip(title, 80), objective: '' }));
}

/** Unique slugs for the screens in order (`lista`, `lista-2`, …). */
export function screenSlugs(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map((title) => {
    const base = slugify(title, 40);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  });
}

export interface ScreenMessagesInput {
  spec: TemplateSpec;
  vars: Record<string, string>;
  documentTitle: string;
  title: string;
  objective: string;
  /** Titles of every screen, with the slugs the links may point to. */
  screens: { title: string; slug: string }[];
  /** Digest of the documentation sections (what the prototype must follow). */
  digest: string;
  instructions?: string;
}

export function buildScreenMessages(input: ScreenMessagesInput): OAIMessage[] {
  const { spec, vars } = input;
  const system = [
    personaText(spec, vars),
    'Você escreve UMA tela de um protótipo navegável em HTML estático, sem JavaScript e sem CSS próprio.',
    `Use SOMENTE estas classes de componentes: ${PROTOTYPE_KIT.map((c) => `.${c}`).join(', ')}.`,
    'Não use style, script, eventos (onclick), iframes nem imagens externas. Tags permitidas: div, section, nav, header, footer, main, aside, h1-h4, p, span, strong, em, ul, ol, li, a, button, form, label, input, select, option, textarea, table, thead, tbody, tr, th, td, small, hr.',
    'Links entre telas só podem usar href="#tela-<slug>" com os slugs fornecidos.',
    'Preencha com dados de exemplo realistas em português do Brasil.',
    'Formato da resposta: primeiro uma descrição em Markdown (finalidade, componentes e estados da tela) e, depois, UM bloco ```html com o fragmento da tela (sem <html>, <head> ou <body>).',
    DATA_NOT_INSTRUCTIONS,
  ].join('\n\n');
  const user = [
    `Documento: ${input.documentTitle}`,
    `Escreva a tela "${input.title}".`,
    input.objective ? `Objetivo da tela: ${input.objective}` : '',
    `Telas do protótipo (para os links):\n${input.screens.map((s) => `- ${s.title}: #tela-${s.slug}`).join('\n')}`,
    variablesBlock(vars),
    input.digest ? `Especificação já escrita (siga-a):\n${input.digest}` : '',
    input.instructions ? `Instruções adicionais do usuário: ${input.instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface ExtractedScreen {
  description: string;
  html: string;
}

/** Splits a screen answer into the Markdown description and the ```html fragment (null when absent). */
export function extractScreen(answer: string): ExtractedScreen | null {
  const text = answer.replace(/\r\n/g, '\n');
  const match = /```html[^\n]*\n([\s\S]*?)(?:```|$)/i.exec(text);
  let html = match?.[1]?.trim() ?? '';
  let description = match
    ? (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim()
    : text.trim();
  if (!html) {
    // a bare fragment (no fence): starts with a tag
    const bare = /^\s*(<(?:div|section|main|header|nav)\b[\s\S]*)$/i.exec(text);
    if (!bare) return null;
    html = bare[1]!.trim();
    description = '';
  }
  return { description: clip(description, 6_000), html: clip(html, 60_000) };
}

export interface PrototypeScreen {
  slug: string;
  title: string;
  /** Already sanitized fragment. */
  html: string;
}

export interface PrototypeInput {
  title: string;
  metaLine: string;
  layout: TemplateLayout;
  screens: PrototypeScreen[];
  /** Rendered documentation sections ("Especificação"). */
  specHtml: string;
}

/** One self-contained HTML file; screens switch with CSS `:target` (no JavaScript). */
export function assemblePrototype(input: PrototypeInput): string {
  const { layout } = input;
  const logo = safeLogo(layout.logo);
  const title = escapeHtml(input.title);
  const nav = [
    ...input.screens.map((s) => `<a href="#tela-${s.slug}">${escapeHtml(s.title)}</a>`),
    `<a href="#${SPEC_SCREEN_ID}">Especificação</a>`,
  ].join('');
  const screens = input.screens
    .map(
      (s) =>
        `<section id="tela-${s.slug}" class="tf-screen"><div class="tf-app">${s.html}</div></section>`,
    )
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<title>${title}</title>`,
    `<style>${prototypeCss(layout)}</style>`,
    '</head>',
    '<body>',
    `<nav class="tf-proto-nav" aria-label="Telas">${logo ? `<img src="${logo}" alt="" style="height:22px">` : ''}<strong>${title}</strong>${nav}</nav>`,
    '<main class="tf-proto-main">',
    screens,
    `<section id="${SPEC_SCREEN_ID}" class="tf-screen"><article class="doc"><div class="content">${input.specHtml}</div></article></section>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

export const isScreen = (s: Pick<ReportSection, 'role'>): boolean => s.role === 'screen';
