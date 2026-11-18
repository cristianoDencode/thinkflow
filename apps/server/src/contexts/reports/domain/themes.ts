import {
  DEFAULT_TEMPLATE_ACCENT_COLOR,
  DEFAULT_TEMPLATE_PRIMARY_COLOR,
  type TemplateLayout,
} from '@thinkflow/shared';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Colors come from validated templates, but they end up in CSS: never trust them blindly. */
export const safeColor = (value: string, fallback: string): string =>
  HEX.test(value) ? value.toLowerCase() : fallback;

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** Header sent with the served document: the `sandbox` directive is only valid as an HTTP header. */
export const CONTENT_SECURITY_POLICY_HEADER = `${CONTENT_SECURITY_POLICY}; sandbox`;

interface Palette {
  primary: string;
  accent: string;
  text: string;
  muted: string;
  rule: string;
  tint: string;
  codeBg: string;
}

function palette(layout: Pick<TemplateLayout, 'primaryColor' | 'accentColor'>): Palette {
  const primary = safeColor(layout.primaryColor, DEFAULT_TEMPLATE_PRIMARY_COLOR);
  const accent = safeColor(layout.accentColor, DEFAULT_TEMPLATE_ACCENT_COLOR);
  return {
    primary,
    accent,
    text: '#1f2330',
    muted: '#5b6070',
    rule: '#dcdde6',
    tint: `${accent}22`,
    codeBg: '#f4f4f8',
  };
}

const SANS =
  "'Inter','Segoe UI',Roboto,'Helvetica Neue','Liberation Sans','Noto Sans',Arial,sans-serif";
const SERIF = "Georgia,'Liberation Serif','Noto Serif','Times New Roman',serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono','DejaVu Sans Mono',monospace";

type ThemeName = TemplateLayout['theme'];

interface ThemeTraits {
  body: string;
  size: string;
  line: string;
  heading: string;
  /** CSS of the theme-specific decorations. */
  extra: (p: Palette) => string;
}

const TRAITS: Record<ThemeName, ThemeTraits> = {
  thinkflow: {
    body: SANS,
    size: '11pt',
    line: '1.55',
    heading: SANS,
    extra: (p) => `
.doc h2{color:${p.primary};border-bottom:2px solid ${p.accent};padding-bottom:.25em}
.doc h3{color:${p.primary}}
.doc table th{background:${p.primary};color:#fff}
.doc blockquote{border-left:4px solid ${p.accent};background:${p.tint}}
.cover{background:linear-gradient(135deg,${p.primary},${p.accent});color:#fff;padding:0 16mm}
.cover h1,.cover .cover-subtitle,.cover .cover-meta{color:#fff}`,
  },
  sobrio: {
    body: SERIF,
    size: '11.5pt',
    line: '1.6',
    heading: SERIF,
    extra: (p) => `
.doc h1,.doc h2,.doc h3{color:#111}
.doc h2{border-bottom:1px solid #999;padding-bottom:.2em}
.doc table th{background:#eceef3;color:#111;border-bottom:2px solid ${p.primary}}
.doc blockquote{border-left:3px solid #999;background:#f7f7f9}
.cover{border-bottom:3px solid ${p.primary}}
.cover h1{color:#111}`,
  },
  compacto: {
    body: SANS,
    size: '9.5pt',
    line: '1.4',
    heading: SANS,
    extra: (p) => `
.doc h2{color:${p.primary};font-size:1.25em;margin-top:1.1em}
.doc h3{font-size:1.05em;color:#333}
.doc table th{background:${p.tint};color:#111;border-bottom:2px solid ${p.primary}}
.doc table td,.doc table th{padding:.25em .5em}
.cover h1{color:${p.primary}}`,
  },
};

/** Inline CSS of the whole document: screen layout, theme and print rules. */
export function documentCss(layout: TemplateLayout): string {
  const p = palette(layout);
  const t = TRAITS[layout.theme] ?? TRAITS.thinkflow;
  return `
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:${p.text};font-family:${t.body};font-size:${t.size};line-height:${t.line}}
.doc{max-width:880px;margin:0 auto;padding:24px 28px 64px}
.doc h1,.doc h2,.doc h3,.doc h4{font-family:${t.heading};line-height:1.25}
.doc h1{font-size:2em;margin:.2em 0 .3em}
.doc h2{font-size:1.5em;margin:1.6em 0 .6em;break-after:avoid}
.doc h3{font-size:1.2em;margin:1.2em 0 .4em;break-after:avoid}
.doc h4{font-size:1.05em;margin:1em 0 .3em;break-after:avoid}
.doc p{margin:.6em 0}
.doc a{color:${p.primary}}
.doc ul,.doc ol{padding-left:1.5em}
.doc li{margin:.2em 0}
.doc code{font-family:${MONO};font-size:.88em;background:${p.codeBg};padding:.1em .3em;border-radius:3px}
.doc pre{font-family:${MONO};font-size:.85em;background:${p.codeBg};padding:.8em 1em;border-radius:6px;overflow:auto;white-space:pre-wrap;word-wrap:break-word;break-inside:avoid}
.doc pre code{background:none;padding:0}
.doc blockquote{margin:.8em 0;padding:.4em 1em;border-radius:0 4px 4px 0;color:#333}
.doc table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92em;page-break-inside:auto}
.doc thead{display:table-header-group}
.doc tr{break-inside:avoid}
.doc th,.doc td{border:1px solid ${p.rule};padding:.4em .6em;text-align:left;vertical-align:top}
.doc img{max-width:100%}
.doc hr{border:0;border-top:1px solid ${p.rule};margin:1.5em 0}
.doc figure.diagram{margin:1em 0;text-align:center;break-inside:avoid}
.doc figure.diagram svg{max-width:100%;height:auto}
.doc figure.diagram figcaption,.mermaid-note{font-size:.8em;color:${p.muted};margin-top:.3em}
.doc pre.mermaid-fallback{text-align:left}
.cover{display:flex;flex-direction:column;justify-content:center;min-height:70vh;padding:48px 28px;margin:0 -28px 32px;break-after:page}
.cover img.logo{max-height:64px;max-width:240px;align-self:flex-start;margin-bottom:32px}
.cover h1{font-size:2.4em;margin:0 0 .3em}
.cover .cover-subtitle{font-size:1.2em;color:${p.muted};margin:0 0 1.5em}
.cover .cover-meta{font-size:.9em;color:${p.muted}}
.doc-head{border-bottom:1px solid ${p.rule};margin-bottom:1.5em;padding-bottom:.8em}
.doc-head .cover-meta{font-size:.85em;color:${p.muted}}
.doc-head img.logo{max-height:48px;margin-bottom:12px;display:block}
.toc{margin:0 0 2em;padding:1em 1.4em;border:1px solid ${p.rule};border-radius:8px;break-inside:avoid;break-after:page}
.toc h2{margin:0 0 .5em;border:0;padding:0;font-size:1.2em}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{margin:.15em 0}
.toc a{text-decoration:none}
.toc .toc-n{display:inline-block;min-width:2em;color:${p.muted}}
.content > h2:first-child{margin-top:0}
${t.extra(p)}
@page{size:${layout.pageSize}}
@media print{
  body{background:#fff}
  .doc{max-width:none;padding:0}
  .cover{min-height:100vh;margin:0}
  ${layout.sectionPageBreak ? '.content > h2{break-before:page}.content > h2:first-child{break-before:auto}' : ''}
  a{text-decoration:none}
  pre,svg,figure{break-inside:avoid}
}`.trim();
}

/** CSS of the prototype: component kit, CSS-only screen navigation (`:target`) and layout. */
export function prototypeCss(layout: TemplateLayout): string {
  const p = palette(layout);
  return `
${documentCss(layout)}
.tf-proto-nav{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 20px;background:${p.primary};color:#fff;font-family:${SANS}}
.tf-proto-nav strong{margin-right:12px}
.tf-proto-nav a{color:#fff;text-decoration:none;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.16);font-size:13px}
.tf-proto-nav a:hover{background:rgba(255,255,255,.3)}
.tf-proto-main{max-width:1080px;margin:0 auto;padding:24px 20px 64px}
.tf-screen{display:none}
.tf-screen:target{display:block}
.tf-proto-main:not(:has(:target)) > .tf-screen:first-of-type{display:block}
.tf-app{font-family:${SANS};font-size:14px;line-height:1.5;color:${p.text}}
.tf-app h1,.tf-app h2,.tf-app h3,.tf-app h4{margin:.6em 0 .4em;line-height:1.25}
.tf-app p{margin:.4em 0}
.tf-nav{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px;margin:0 0 16px;background:#f3f1fa;border-radius:8px}
.tf-nav a{color:${p.primary};text-decoration:none;font-weight:600}
.tf-card{border:1px solid ${p.rule};border-radius:10px;padding:14px 16px;margin:0 0 14px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.tf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.tf-btn,.tf-btn-primary{display:inline-block;border:1px solid ${p.primary};border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer;text-decoration:none;background:#fff;color:${p.primary}}
.tf-btn-primary{background:${p.primary};color:#fff}
.tf-input{display:block;width:100%;max-width:420px;border:1px solid #b9bccb;border-radius:6px;padding:6px 10px;font:inherit;background:#fff}
.tf-table{border-collapse:collapse;width:100%;margin:8px 0}
.tf-table th,.tf-table td{border-bottom:1px solid ${p.rule};padding:8px 10px;text-align:left}
.tf-table th{background:#f3f1fa}
.tf-badge{display:inline-block;padding:1px 9px;border-radius:999px;background:${p.tint};color:${p.primary};font-size:12px;font-weight:600}
.tf-alert{border-left:4px solid ${p.accent};background:${p.tint};padding:10px 14px;border-radius:0 6px 6px 0;margin:10px 0}
@media print{.tf-proto-nav{display:none}.tf-screen{display:block;break-after:page}}`.trim();
}
