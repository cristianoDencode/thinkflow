import { DEFAULT_CT_LAYOUT, type CtLayout } from '@thinkflow/shared';
import {
  ctAnalysisTitle,
  ctLines,
  ctUseCaseTitle,
  fitImage,
  type CtDocument,
  type CtItem,
  type CtUseCase,
} from '../../domain/ct-document';
import { ctLogoOf } from './ct-logo';
import {
  CT_FONT_SIZES,
  CT_SECTION_NUMBERS,
  CT_TEXTS,
  CT_VERSION_COLS,
  CtImageFormatError,
  ctDocumentTitleForFile,
  ctFontStack,
  ctPalette,
  sniffImage,
  type CtPalette,
} from './ct-style';

/*
 * HTML of the "Caso de Teste CT" in three flavours:
 * The look (colors, font, header / footer texts, logo) comes from the document model (`layout`).
 *  - preview (default): a standalone page for on-screen preview (simulated page header / footer);
 *  - `forPdf`: the same body without the simulated header / footer, for Chromium's `page.pdf`
 *    (the real header / footer come from `ctPdfTemplates`, which can number the pages);
 *  - `clipboardSection: 'plano'`: only the "Caso de Uso" blocks of the Plano de Teste, as an HTML
 *    fragment with inline styles, data-URI images and fixed pixel sizes, so a paste into Word
 *    (desktop or Online) keeps tables, shading and image sizes.
 * Every text is escaped; image URLs are limited to http(s), blob:, data:image and relative URLs.
 */

export interface CtHtmlOptions {
  forPdf?: boolean;
  clipboardSection?: 'plano';
  /** Document model; default: the neutral built-in one. */
  layout?: CtLayout;
}

/** What the HTML builders need of the model. */
interface Look {
  font: string;
  c: CtPalette;
}

const lookOf = (layout: CtLayout): Look => ({
  font: ctFontStack(layout.fontFamily),
  c: ctPalette(layout),
});

/** Usable image width in a use case block: content (17 cm) minus both paddings, in CSS px. */
const IMAGE_MAX_W = 628;
const IMAGE_MAX_H = 866;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only URLs that cannot run script or reach unexpected schemes; anything else becomes ''. */
export function safeImageUrl(url: string): string {
  const value = url.trim();
  if (/^data:image\/(png|jpeg|gif|bmp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  if (/^(https?:|blob:)/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return '';
  return value;
}

/** `data:` URI of image bytes (PNG, JPEG, GIF); used for PDF and clipboard variants. */
export function ctImageDataUri(bytes: Uint8Array, key = 'imagem'): string {
  const sniffed = sniffImage(bytes);
  if (!sniffed || sniffed.type === 'bmp') throw new CtImageFormatError(key);
  return `data:${sniffed.mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Text with preserved line breaks and blank lines. */
function multiline(text: string): string {
  return ctLines(text).map(escapeHtml).join('<br>');
}

/* ------------------------------ use case items ------------------------------ */

const pBase = (k: Look): string =>
  `margin:0;font-family:${k.font};font-size:${CT_FONT_SIZES.body}pt;color:#${k.c.text}`;

function textLines(text: string, k: Look): string {
  return ctLines(text)
    .map((line) => `<p style="${pBase(k)}">${line === '' ? '&nbsp;' : escapeHtml(line)}</p>`)
    .join('');
}

function codeLines(text: string, k: Look): string {
  return ctLines(text)
    .map(
      (line) =>
        `<p style="margin:0;font-family:${k.font};font-size:${CT_FONT_SIZES.code}pt;color:#${k.c.text};white-space:pre-wrap">${line === '' ? '&nbsp;' : escapeHtml(line)}</p>`,
    )
    .join('');
}

function imageHtml(
  item: Extract<CtItem, { kind: 'image' }>,
  src: string,
  fixedSize: boolean,
  k: Look,
): string {
  const url = safeImageUrl(src);
  const alt = escapeHtml(item.caption?.trim() || 'Captura de tela');
  const size = fitImage(item.width, item.height, IMAGE_MAX_W, IMAGE_MAX_H);
  const img = fixedSize
    ? `<img src="${escapeHtml(url)}" alt="${alt}" width="${size.width}" height="${size.height}" style="display:block;width:${size.width}px;height:${size.height}px;border:0">`
    : `<img src="${escapeHtml(url)}" alt="${alt}" width="${item.width}" height="${item.height}" style="display:block;width:100%;height:auto;border:0">`;
  const caption = item.caption?.trim()
    ? `<p style="margin:0 0 3pt 0;text-align:center;font-family:${k.font};font-size:${CT_FONT_SIZES.label}pt;font-style:italic;color:#${k.c.gray}">${escapeHtml(item.caption.trim())}</p>`
    : '';
  const wrap = fixedSize ? 'margin:2pt 0 3pt 0' : 'margin:2pt 0 3pt 0;break-inside:avoid';
  return `<div style="${wrap}">${img}${caption}</div>`;
}

function itemsHtml(
  useCase: CtUseCase,
  imageUrl: (key: string) => string,
  fixedSize: boolean,
  k: Look,
): string {
  const html = useCase.items
    .map((item) => {
      switch (item.kind) {
        case 'text':
          return textLines(item.text, k);
        case 'code':
          return codeLines(item.text, k);
        case 'image':
          return imageHtml(item, imageUrl(item.key), fixedSize, k);
      }
    })
    .join('');
  return html || `<p style="${pBase(k)}">&nbsp;</p>`;
}

/* ------------------------------ clipboard variant ------------------------------ */

const CELL_PAD = `1.5pt ${5.25}pt`;

function clipboardUseCase(
  useCase: CtUseCase,
  index: number,
  imageUrl: (key: string) => string,
  k: Look,
): string {
  const border = `1px solid #${k.c.blockBorder}`;
  const base = `font-family:${k.font};border:${border};padding:${CELL_PAD}`;
  return [
    `<table width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed">`,
    '<tbody>',
    '<tr>',
    `<td width="48%" style="${base};width:48%;background-color:#${k.c.labelBg};vertical-align:middle"><p style="${pBase(k)};font-size:${CT_FONT_SIZES.useCaseTitle}pt;font-weight:bold;color:#${k.c.heading}"><b>${escapeHtml(ctUseCaseTitle(useCase, index))}</b></p></td>`,
    `<td style="${base};vertical-align:middle"><p style="${pBase(k)};font-size:${CT_FONT_SIZES.status}pt;font-style:italic;color:#${k.c.green}"><i>${escapeHtml(useCase.status)}</i></p></td>`,
    '</tr>',
    '<tr>',
    `<td colspan="2" style="${base};padding:2pt 5.25pt;vertical-align:top">${itemsHtml(useCase, imageUrl, true, k)}</td>`,
    '</tr>',
    '</tbody>',
    '</table>',
  ].join('');
}

function clipboardHtml(doc: CtDocument, imageUrl: (key: string) => string, k: Look): string {
  const gap = `<p style="margin:0;font-size:4pt;line-height:4pt">&nbsp;</p>`;
  return `<div style="font-family:${k.font}">${doc.useCases
    .map((useCase, i) => clipboardUseCase(useCase, i, imageUrl, k))
    .join(gap)}</div>`;
}

/* ------------------------------ full document ------------------------------ */

const css = (k: Look): string => `
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:${k.font};font-size:${CT_FONT_SIZES.body}pt;line-height:normal;color:#${k.c.text};background:#fff}
.ct{width:100%}
.screen body,body.screen{background:#ececec}
.sheet{width:210mm;min-height:297mm;margin:12px auto;padding:7mm 20mm 14mm;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.25)}
.pdf .ct{padding:0 4mm}
.pghead{display:flex;gap:12pt;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #${k.c.rule};padding-bottom:4pt;margin-bottom:18pt;font-size:${CT_FONT_SIZES.header}pt;color:#${k.c.gray}}
.pghead img{height:20.52pt;width:auto;max-width:180px}
.pghead.logo-left{flex-direction:row-reverse}
.pghead.only-logo-left{justify-content:flex-start}
.pghead.only-logo-right{justify-content:flex-end}
.pgfoot{margin-top:40pt;border-top:1px solid #${k.c.rule};padding-top:4pt;text-align:center;font-size:${CT_FONT_SIZES.footer}pt;color:#${k.c.gray}}
.kicker{font-size:${CT_FONT_SIZES.kicker}pt;color:#${k.c.blue};margin:0 0 6.5pt}
.pdf .ct>:first-child{margin-top:22pt}
h1.title{font-size:${CT_FONT_SIZES.title}pt;font-weight:700;color:#${k.c.heading};margin:0 0 2.5pt}
h2.sec{font-size:${CT_FONT_SIZES.h1}pt;font-weight:700;color:#${k.c.heading};margin:34pt 0 8pt;padding-bottom:5pt;border-bottom:1px solid #${k.c.rule};break-after:avoid}
h2.sec.first{margin-top:23pt}
h2.sec .n{color:#${k.c.blue}}
h3.sub{font-size:${CT_FONT_SIZES.h2}pt;font-weight:700;color:#${k.c.heading};margin:13pt 0 4pt;break-after:avoid}
table{border-collapse:collapse;table-layout:fixed;width:100%}
table.hdr td{border:.75pt solid #${k.c.tableBorder};padding:1pt ${CT_FONT_SIZES.body / 2}pt;vertical-align:middle}
table.hdr td.l{background:#${k.c.labelBg};font-size:${CT_FONT_SIZES.label}pt;font-weight:700;color:#${k.c.heading}}
table.ver td,table.ver th{border:1px solid #${k.c.blockBorder};padding:3pt 5.25pt;font-size:${CT_FONT_SIZES.version}pt;vertical-align:middle;overflow-wrap:anywhere}
table.ver th{background:#${k.c.labelBg};font-weight:700;color:#${k.c.heading};text-align:center}
table.ver td.c{text-align:center}
table.ver tr{break-inside:avoid}
.ctx{border:1px solid #${k.c.rule};border-bottom:2px solid #${k.c.rule};padding:3.8pt 5.25pt;white-space:pre-wrap;overflow-wrap:anywhere;min-height:20pt}
.uc{border:1px solid #${k.c.blockBorder};margin-bottom:4pt}
.uc-head{display:flex;border-bottom:1px solid #${k.c.blockBorder};break-after:avoid}
.uc-title{width:48%;background:#${k.c.labelBg};font-size:${CT_FONT_SIZES.useCaseTitle}pt;font-weight:700;color:#${k.c.heading};padding:1.5pt 5.25pt}
.uc-status{flex:1;font-size:${CT_FONT_SIZES.status}pt;font-style:italic;color:#${k.c.green};padding:1.5pt 5.25pt}
.uc-body{padding:2pt 5.25pt;overflow-wrap:anywhere}
`;

const CSP_PDF = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const CSP_PREVIEW = "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'";

function useCaseBlock(
  useCase: CtUseCase,
  index: number,
  imageUrl: (key: string) => string,
  k: Look,
): string {
  return [
    '<section class="uc">',
    '<div class="uc-head">',
    `<div class="uc-title">${escapeHtml(ctUseCaseTitle(useCase, index))}</div>`,
    `<div class="uc-status">${escapeHtml(useCase.status)}</div>`,
    '</div>',
    `<div class="uc-body">${itemsHtml(useCase, imageUrl, false, k)}</div>`,
    '</section>',
  ].join('');
}

/** Simulated page header of the preview: text and logo on opposite sides (nothing when off). */
function pageHeaderHtml(layout: CtLayout): string {
  if (!layout.showHeader) return '';
  const logo = ctLogoOf(layout);
  const text = layout.headerText ? `<span>${escapeHtml(layout.headerText)}</span>` : '';
  if (!text && !logo) return '';
  const img = logo ? `<img src="${escapeHtml(logo.dataUri)}" alt="Logotipo">` : '';
  const left = layout.logoPosition === 'left';
  const cls = [
    'pghead',
    left ? 'logo-left' : '',
    !text && logo ? (left ? 'only-logo-left' : 'only-logo-right') : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}">${text}${img}</div>`;
}

/** Footer text of the preview; the real page numbers only exist in the DOCX and the PDF. */
function pageFooterHtml(layout: CtLayout): string {
  if (!layout.showFooter) return '';
  const text = [layout.footerText, 'Página X de Y'].filter(Boolean).join('   ·   ');
  return `<div class="pgfoot">${escapeHtml(text)}</div>`;
}

function section(n: string, title: string, first = false): string {
  return `<h2 class="sec${first ? ' first' : ''}"><span class="n">${n}.</span> ${escapeHtml(title)}</h2>`;
}

function headerTable(doc: CtDocument): string {
  const l = CT_TEXTS.labels;
  const row = (cells: string): string => `<tr>${cells}</tr>`;
  const label = (text: string): string => `<td class="l">${escapeHtml(text)}</td>`;
  const value = (text: string, span = 1): string =>
    `<td${span > 1 ? ` colspan="${span}"` : ''}>${multiline(text)}</td>`;
  return [
    '<table class="hdr"><colgroup><col width="25%"><col width="25%"><col width="25%"><col width="25%"></colgroup><tbody>',
    row(label(l.title) + value(doc.title, 3)),
    row(label(l.ticketId) + value(doc.ticketId) + label(l.priority) + value(doc.priority)),
    row(label(l.systemModule) + value(doc.systemModule, 3)),
    row(label(l.author) + value(doc.author, 3)),
    '</tbody></table>',
  ].join('');
}

function versionsTable(doc: CtDocument): string {
  const cols = CT_VERSION_COLS.map((c) => `<col width="${c / 100}%">`).join('');
  const head = CT_TEXTS.versionHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const rows = doc.versions
    .map(
      (v) =>
        `<tr><td class="c">${escapeHtml(v.version)}</td><td class="c">${escapeHtml(v.date)}</td><td>${escapeHtml(v.description)}</td><td>${escapeHtml(v.author)}</td></tr>`,
    )
    .join('');
  return `<table class="ver"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Standalone HTML of the document. `imageUrl(key)` gives the `src` of each screenshot: use data
 * URIs (`ctImageDataUri`) for the PDF (JavaScript and network are off) and for the clipboard.
 */
export function renderCtHtml(
  doc: CtDocument,
  imageUrl: (key: string) => string,
  opts: CtHtmlOptions = {},
): string {
  const layout = opts.layout ?? DEFAULT_CT_LAYOUT;
  const k = lookOf(layout);
  if (opts.clipboardSection === 'plano') return clipboardHtml(doc, imageUrl, k);

  const pdf = opts.forPdf === true;
  const n = CT_SECTION_NUMBERS;
  const body = [
    pdf ? '' : pageHeaderHtml(layout),
    layout.kicker ? `<div class="kicker">${escapeHtml(layout.kicker)}</div>` : '',
    `<h1 class="title">${escapeHtml(layout.title)}</h1>`,
    section(n.header, CT_TEXTS.s1, true),
    headerTable(doc),
    section(n.analysis, ctAnalysisTitle(doc)),
    `<h3 class="sub">${n.context}. ${escapeHtml(CT_TEXTS.s2sub)}</h3>`,
    `<div class="ctx">${escapeHtml(doc.context.replace(/\r\n?/g, '\n'))}</div>`,
    section(n.plan, CT_TEXTS.s3),
    `<h3 class="sub">${n.criteria}. ${escapeHtml(CT_TEXTS.s3sub)}</h3>`,
    ...doc.useCases.map((useCase, i) => useCaseBlock(useCase, i, imageUrl, k)),
    section(n.versions, CT_TEXTS.versions),
    versionsTable(doc),
    pdf ? '' : pageFooterHtml(layout),
  ].join('\n');

  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${pdf ? CSP_PDF : CSP_PREVIEW}">`,
    `<title>${escapeHtml(ctDocumentTitleForFile(doc))}</title>`,
    `<style>${css(k)}</style>`,
    '</head>',
    `<body class="${pdf ? 'pdf' : 'screen'}">`,
    pdf ? `<main class="ct">${body}</main>` : `<main class="sheet ct">${body}</main>`,
    '</body>',
    '</html>',
  ].join('\n');
}
