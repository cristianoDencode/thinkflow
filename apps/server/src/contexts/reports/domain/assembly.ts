import type { TemplateLayout } from '@thinkflow/shared';
import type { ReportMeta, ReportSection } from './report';
import { CONTENT_SECURITY_POLICY, documentCss, safeColor } from './themes';

/** Lowercase ASCII slug (accents removed), at most `max` characters. */
export function slugify(text: string, max = 80): string {
  const slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'documento';
}

export interface TocEntry {
  number: number;
  title: string;
  anchor: string;
}

/** Numbered table of contents ("1. Resumo"); anchors are `sec-<n>-<slug>`. */
export function buildToc(sections: Pick<ReportSection, 'title' | 'role'>[]): TocEntry[] {
  return sections
    .filter((s) => s.role === 'section')
    .map((s, i) => ({
      number: i + 1,
      title: s.title,
      anchor: `sec-${i + 1}-${slugify(s.title, 40)}`,
    }));
}

export interface AssemblyInput {
  title: string;
  templateName: string;
  variables: Record<string, string>;
  /** Variable labels by name, for the appendix. */
  variableLabels?: Record<string, string>;
  meta: ReportMeta;
  generatedAt: number;
}

export const formatDate = (at: number): string =>
  new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(at));

const SOURCE_KIND_LABELS = {
  mcp: 'ferramenta',
  library: 'biblioteca',
  attachment: 'anexo',
} as const;

function sectionBody(section: ReportSection): string {
  if (section.status === 'done' && section.markdown.trim()) return section.markdown.trim();
  if (section.status === 'error')
    return `_Esta seção não pôde ser gerada${section.error ? ` (${section.error})` : ''}. Use "Reescrever" para tentar de novo._`;
  return '_Esta seção ainda não foi gerada._';
}

/** The appendix "Sobre este documento": provenance, sources, variables and limits. */
export function aboutSection(input: AssemblyInput, sections: ReportSection[]): string {
  const { meta } = input;
  const lines = [
    '## Sobre este documento',
    '',
    `- **Gerado em:** ${formatDate(input.generatedAt)}`,
    `- **Modelo de documento:** ${input.templateName}`,
  ];
  if (meta.models.length) lines.push(`- **Modelos de IA:** ${meta.models.join(', ')}`);
  if (meta.sources.length) {
    lines.push('- **Fontes consultadas:**');
    for (const s of meta.sources)
      lines.push(
        `  - ${SOURCE_KIND_LABELS[s.kind]} \`${s.name}\`${s.kind === 'attachment' ? '' : ` (${s.calls} ${s.calls === 1 ? 'consulta' : 'consultas'})`}`,
      );
  } else lines.push('- **Fontes consultadas:** nenhuma ferramenta foi consultada.');
  const vars = Object.entries(input.variables).filter(([, v]) => v);
  if (vars.length) {
    lines.push('- **Variáveis:**');
    for (const [name, value] of vars)
      lines.push(`  - ${input.variableLabels?.[name] ?? name}: ${value.replace(/\s+/g, ' ')}`);
  }
  lines.push(
    '- **Limites:**',
    '  - Conteúdo gerado por IA a partir das fontes consultadas; confira os pontos críticos.',
  );
  for (const limit of meta.limits) lines.push(`  - ${limit}`);
  for (const warning of meta.warnings) lines.push(`  - ${warning}`);
  const failed = sections.filter((s) => s.status === 'error').length;
  if (failed > 0)
    lines.push(
      `  - ${failed} ${failed === 1 ? 'seção não foi gerada' : 'seções não foram geradas'}.`,
    );
  if (meta.diagrams.total > 0) {
    const d = meta.diagrams;
    const notes = [
      d.repaired ? `${d.repaired} corrigido${d.repaired === 1 ? '' : 's'} automaticamente` : '',
      d.unvalidated ? `${d.unvalidated} sem validação de sintaxe` : '',
      d.failed
        ? `${d.failed} com erro de sintaxe (mantido${d.failed === 1 ? '' : 's'} como código)`
        : '',
    ].filter(Boolean);
    lines.push(`  - Diagramas: ${d.total} no total${notes.length ? `, ${notes.join(', ')}` : ''}.`);
  }
  return lines.join('\n');
}

/** Screens of a prototype, described in Markdown (their HTML lives in the prototype page). */
function screensSection(sections: ReportSection[]): string | null {
  const screens = sections.filter((s) => s.role === 'screen' && s.status === 'done');
  if (screens.length === 0) return null;
  return [
    '## Telas do protótipo',
    ...screens.map((s) => `### ${s.title}\n\n${s.markdown.trim()}`),
  ].join('\n\n');
}

/**
 * Everything after the title: one numbered `##` per section, the prototype screens (if any) and the
 * appendix. The HTML rendering uses this part, since the cover/header already carries the title.
 */
export function assembleBodyMarkdown(input: AssemblyInput, sections: ReportSection[]): string {
  const parts: string[] = [];
  const toc = buildToc(sections);
  const ordered = sections.filter((s) => s.role === 'section');
  ordered.forEach((section, i) => {
    const heading = `## ${toc[i]!.number}. ${section.title}`;
    parts.push(`${heading}\n\n${sectionBody(section)}`);
  });
  const screens = screensSection(sections);
  if (screens) parts.push(screens);
  parts.push(aboutSection(input, sections));
  return parts.join('\n\n');
}

/**
 * The whole document as Markdown: title, one numbered `##` per section and the appendix. This is
 * what the Markdown export and "Adicionar à Biblioteca" use.
 */
export function assembleMarkdown(input: AssemblyInput, sections: ReportSection[]): string {
  const head = [`# ${input.title}`, `_${input.templateName} · ${formatDate(input.generatedAt)}_`];
  return `${[...head, assembleBodyMarkdown(input, sections)].join('\n\n')}\n`;
}

/* ------------------------------ HTML document ------------------------------ */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

export const APPENDIX_TITLE = 'Sobre este documento';
export const APPENDIX_ANCHOR = 'sobre-este-documento';
export const SCREENS_TITLE = 'Telas do protótipo';

/** `h2` text -> id for the headings the table of contents points at. */
export function headingIds(
  sections: Pick<ReportSection, 'title' | 'role'>[],
): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const entry of buildToc(sections)) ids[`${entry.number}. ${entry.title}`] = entry.anchor;
  ids[APPENDIX_TITLE] = APPENDIX_ANCHOR;
  return ids;
}

export function buildTocHtml(toc: TocEntry[]): string {
  const items = toc.map(
    (e) =>
      `<li><a href="#${escapeHtml(e.anchor)}"><span class="toc-n">${e.number}.</span>${escapeHtml(e.title)}</a></li>`,
  );
  items.push(
    `<li><a href="#${APPENDIX_ANCHOR}"><span class="toc-n"></span>${APPENDIX_TITLE}</a></li>`,
  );
  return `<nav class="toc" aria-label="Sumário"><h2>Sumário</h2><ol>${items.join('')}</ol></nav>`;
}

const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;
/** A logo is only ever embedded as a PNG/JPEG data URL (re-checked here, whatever the template says). */
export const safeLogo = (logo: string | null): string | null =>
  logo && LOGO_RE.test(logo) ? logo : null;

export interface DocumentHtmlInput {
  title: string;
  /** Template name + date line shown on the cover. */
  metaLine: string;
  layout: TemplateLayout;
  /** Cover subtitle with the variables already applied. */
  subtitle: string;
  tocHtml: string;
  bodyHtml: string;
}

/** The complete, self-contained HTML page (no scripts, no remote resources). */
export function renderDocumentHtml(input: DocumentHtmlInput): string {
  const { layout } = input;
  const logo = safeLogo(layout.logo);
  const logoHtml = logo ? `<img class="logo" alt="" src="${logo}">` : '';
  const title = escapeHtml(input.title);
  const subtitle = input.subtitle
    ? `<p class="cover-subtitle">${escapeHtml(input.subtitle)}</p>`
    : '';
  const head = layout.cover
    ? `<header class="cover">${logoHtml}<h1>${title}</h1>${subtitle}<p class="cover-meta">${escapeHtml(input.metaLine)}</p></header>`
    : `<header class="doc-head">${logoHtml}<h1>${title}</h1>${subtitle}<p class="cover-meta">${escapeHtml(input.metaLine)}</p></header>`;
  const toc = layout.toc ? input.tocHtml : '';
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<title>${title}</title>`,
    `<style>${documentCss(layout)}</style>`,
    '</head>',
    '<body>',
    `<main class="doc">${head}${toc}<div class="content">${input.bodyHtml}</div></main>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/* ------------------------------ PDF header / footer ------------------------------ */

export interface PdfTemplates {
  headerTemplate: string;
  footerTemplate: string;
}

/** Chromium header/footer: the text is escaped, page numbers are filled in by the print engine. */
export function pdfTemplates(
  layout: TemplateLayout,
  title: string,
  texts: { header: string; footer: string },
): PdfTemplates {
  const color = safeColor(layout.primaryColor, '#6d28d9');
  const logo = safeLogo(layout.logo);
  const base =
    'font-size:8px;width:100%;padding:0 16mm;display:flex;justify-content:space-between;align-items:center;color:#666;font-family:Arial,sans-serif';
  const header = escapeHtml(texts.header.trim() || title);
  return {
    headerTemplate: `<div style="${base};border-bottom:0"><span style="color:${color}">${header}</span>${logo ? `<img src="${logo}" style="height:7mm">` : '<span></span>'}</div>`,
    footerTemplate: `<div style="${base}"><span>${escapeHtml(texts.footer.trim())}</span><span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
  };
}
