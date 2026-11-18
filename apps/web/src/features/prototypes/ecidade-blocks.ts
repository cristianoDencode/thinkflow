/*
 * Built-in "e-Cidade" blocks of the prototype editor: client-side, deterministic, styled like the
 * classic e-Cidade UI (small Arial 11px, gray page, blue window title bars, bevelled buttons).
 * Every block root carries an `ec-*` class; the CSS is shared (`ECIDADE_CSS`) and is added to the
 * prototype when a block is dropped (the editor merges identical rules, so it never duplicates).
 */

export interface BlockDef {
  id: string;
  label: string;
  category: string;
  /** Short glyph shown in the palette tile. */
  icon: string;
  html: string;
  css: string;
  /** Tooltip of the palette tile. */
  title?: string;
  /** Favorites: the inserted component is tied to its scoped CSS (see `favorites.ts`). */
  scope?: string;
}

export const ECIDADE_CATEGORY = 'e-Cidade';

/*
 * Every block root carries `data-ec="<kind>"` and its pieces `data-ec-part="<part>"` — the same
 * markers the capture puts on real e-Cidade screens (see `ECIDADE_COMPONENT_KINDS` in the shared
 * contract) — so one set of component types and traits edits both. The classes only style.
 */

const FONT = '11px Arial, Helvetica, sans-serif';

const css = {
  base: `
.ec-field,.ec-combo,.ec-lookup,.ec-date,.ec-daterange,.ec-textarea,.ec-check,.ec-radios,.ec-buttons,.ec-fieldset,.ec-grid,.ec-tabs,.ec-title,.ec-status,.ec-msg{font:${FONT};color:#000;box-sizing:border-box}
.ec-label{font-weight:bold;min-width:110px;color:#000;white-space:nowrap}
.ec-link{color:#0000cc;text-decoration:underline;cursor:pointer}
.ec-input,.ec-select,.ec-area{font:${FONT};height:18px;border:1px solid #999999;background:#ffffff;padding:1px 3px;color:#000;box-sizing:border-box;border-radius:0}
.ec-area{height:64px;width:420px;resize:none}
.ec-input[readonly],.ec-readonly{background:#deb887}
.ec-w-s{width:80px}
.ec-w-m{width:200px}
.ec-w-l{width:320px}
.ec-select{height:20px;min-width:140px;padding:0 2px}
.ec-field,.ec-combo,.ec-lookup,.ec-date,.ec-daterange,.ec-textarea,.ec-check,.ec-radios,.ec-buttons,.ec-msg,.ec-fieldset,.ec-tabs{width:fit-content;max-width:100%}`,
  row: `
.ec-field,.ec-combo,.ec-lookup,.ec-date,.ec-daterange{display:flex;align-items:center;gap:6px;margin:3px 0;padding:0 4px}
.ec-textarea{display:flex;align-items:flex-start;gap:6px;margin:3px 0;padding:0 4px}`,
  btn: `
.ec-btn,.ec-lookup-btn,.ec-cal-btn{font:${FONT};height:20px;padding:0 10px;color:#000;background:linear-gradient(#f4f4f4,#d4d0c8);border:1px solid #707070;border-radius:2px;cursor:pointer}
.ec-lookup-btn,.ec-cal-btn{padding:0 4px;min-width:24px;line-height:16px}
.ec-buttons{display:flex;gap:6px;justify-content:center;margin:8px 0;padding:4px}`,
  check: `
.ec-check{display:flex;align-items:center;gap:4px;margin:3px 0;padding:0 4px}
.ec-radios{display:flex;align-items:center;gap:12px;margin:3px 0;padding:0 4px}
.ec-radio{display:inline-flex;align-items:center;gap:3px}`,
  fieldset: `
.ec-fieldset{border:1px solid #888888;margin:6px 0;padding:6px 8px;background:#e9e9e9}
.ec-legend{font:bold ${FONT};color:#000066;padding:0 4px}`,
  grid: `
.ec-grid{border-collapse:collapse;width:100%;background:#ffffff}
.ec-grid th{background:#2c4a7c;color:#ffffff;font-weight:bold;border:1px solid #ffffff;padding:2px 6px;text-align:left;height:18px}
.ec-grid td{border:1px solid #cccccc;padding:2px 6px;height:18px;background:#ffffff}
.ec-grid tbody tr:nth-child(even) td{background:#e8eef7}`,
  tabs: `
.ec-tabs{margin:6px 0}
.ec-tabs-head{display:flex;gap:2px;border-bottom:1px solid #707070}
.ec-tab{padding:3px 14px;background:#d4d0c8;border:1px solid #707070;border-bottom:0;border-radius:3px 3px 0 0;cursor:pointer}
.ec-tab-active{background:#ffffff;font-weight:bold;position:relative;top:1px}
.ec-tabs-body{border:1px solid #707070;border-top:0;background:#ffffff;padding:8px;min-height:60px}`,
  status: `
.ec-status{display:flex;align-items:center;gap:18px;background:#d4d0c8;border-top:1px solid #707070;padding:2px 8px;min-height:20px}
.ec-sep{font-weight:bold}`,
  title: `
.ec-title{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(#3d78c9,#1d4f9c);color:#ffffff;font:bold 12px Arial,Helvetica,sans-serif;padding:3px 8px;min-height:24px}
.ec-title-text{color:#ffffff}
.ec-title-ctl{letter-spacing:6px;font-weight:normal}`,
  msg: `
.ec-msg{display:flex;align-items:center;gap:8px;margin:6px 0;padding:6px 10px;border:1px solid #6a8fc7;background:#e6f0ff}
.ec-msg-warn{border-color:#d9a000;background:#fff6d6}
.ec-msg-error{border-color:#c03030;background:#ffe3e3}
.ec-msg-icon{font-weight:bold;font-size:13px}`,
};

const join = (...parts: string[]) => parts.join('\n').trim();

export const ECIDADE_BLOCKS: BlockDef[] = [
  {
    id: 'ec-title',
    label: 'Título de janela',
    category: ECIDADE_CATEGORY,
    icon: '▬',
    html: '<div class="ec-title" data-ec="window-title"><span class="ec-title-text" data-ec-part="title">Consultas &gt; Consulta Empenho</span><span class="ec-title-ctl">_ □ ×</span></div>',
    css: css.title,
  },
  {
    id: 'ec-field',
    label: 'Campo com rótulo',
    category: ECIDADE_CATEGORY,
    icon: 'Ab|',
    html: '<div class="ec-field" data-ec="field"><label class="ec-label" data-ec-part="label">Código:</label><input class="ec-input ec-w-m" data-ec-part="input" type="text" value="" /></div>',
    css: join(css.base, css.row),
  },
  {
    id: 'ec-combo',
    label: 'Combo',
    category: ECIDADE_CATEGORY,
    icon: '▾',
    html: '<div class="ec-combo" data-ec="select"><label class="ec-label" data-ec-part="label">Situação:</label><select class="ec-select" data-ec-part="input"><option>Todas</option><option>Ativas</option><option>Inativas</option></select></div>',
    css: join(css.base, css.row),
  },
  {
    id: 'ec-lookup',
    label: 'Lookup (pesquisa)',
    category: ECIDADE_CATEGORY,
    icon: '🔍',
    html: '<div class="ec-lookup" data-ec="lookup"><label class="ec-label ec-link" data-ec-part="label">Empenho:</label><input class="ec-input ec-w-s" data-ec-part="input" type="text" value="" /><button type="button" class="ec-lookup-btn" data-ec-part="button">🔍</button><input class="ec-input ec-readonly ec-w-l" data-ec-part="desc" type="text" value="" readonly="readonly" /></div>',
    css: join(css.base, css.row, css.btn),
  },
  {
    id: 'ec-date',
    label: 'Data',
    category: ECIDADE_CATEGORY,
    icon: '📅',
    html: '<div class="ec-date" data-ec="date"><label class="ec-label" data-ec-part="label">Data:</label><input class="ec-input ec-w-s" data-ec-part="input" type="text" placeholder="dd/mm/aaaa" value="" /><button type="button" class="ec-cal-btn" data-ec-part="button">📅</button></div>',
    css: join(css.base, css.row, css.btn),
  },
  {
    id: 'ec-daterange',
    label: 'Data (intervalo)',
    category: ECIDADE_CATEGORY,
    icon: '📅',
    html: '<div class="ec-daterange" data-ec="date-range"><label class="ec-label" data-ec-part="label">Período:</label><input class="ec-input ec-w-s" data-ec-part="input" type="text" placeholder="dd/mm/aaaa" value="" /><button type="button" class="ec-cal-btn" data-ec-part="button">📅</button><span class="ec-sep" data-ec-part="separator">a</span><input class="ec-input ec-w-s" data-ec-part="input" type="text" placeholder="dd/mm/aaaa" value="" /><button type="button" class="ec-cal-btn" data-ec-part="button">📅</button></div>',
    css: join(css.base, css.row, css.btn, css.status),
  },
  {
    id: 'ec-textarea',
    label: 'Área de texto',
    category: ECIDADE_CATEGORY,
    icon: '¶',
    html: '<div class="ec-textarea" data-ec="textarea"><label class="ec-label" data-ec-part="label">Observação:</label><textarea class="ec-area" data-ec-part="input"></textarea></div>',
    css: join(css.base, css.row),
  },
  {
    id: 'ec-check',
    label: 'Caixa de seleção',
    category: ECIDADE_CATEGORY,
    icon: '☑',
    html: '<div class="ec-check" data-ec="checkbox"><input type="checkbox" data-ec-part="input" /><label class="ec-label" data-ec-part="label">Exibir cancelados</label></div>',
    css: join(css.base, css.check),
  },
  {
    id: 'ec-radios',
    label: 'Grupo de opções',
    category: ECIDADE_CATEGORY,
    icon: '◉',
    html: '<div class="ec-radios" data-ec="radio-group"><label class="ec-label" data-ec-part="label">Tipo:</label><label class="ec-radio"><input type="radio" name="tipo" checked="checked" data-ec-part="input" />Analítico</label><label class="ec-radio"><input type="radio" name="tipo" data-ec-part="input" />Sintético</label></div>',
    css: join(css.base, css.check),
  },
  {
    id: 'ec-btn',
    label: 'Botão',
    category: ECIDADE_CATEGORY,
    icon: '▭',
    html: '<button type="button" class="ec-btn" data-ec="button">Pesquisar</button>',
    css: join(css.base, css.btn),
  },
  {
    id: 'ec-buttons',
    label: 'Barra de botões',
    category: ECIDADE_CATEGORY,
    icon: '▭▭',
    html: '<div class="ec-buttons" data-ec="button-bar"><button type="button" class="ec-btn" data-ec-part="button">Incluir</button><button type="button" class="ec-btn" data-ec-part="button">Alterar</button><button type="button" class="ec-btn" data-ec-part="button">Excluir</button><button type="button" class="ec-btn" data-ec-part="button">Pesquisar</button></div>',
    css: join(css.base, css.btn),
  },
  {
    id: 'ec-fieldset',
    label: 'Grupo com legenda',
    category: ECIDADE_CATEGORY,
    icon: '▢',
    html: '<fieldset class="ec-fieldset" data-ec="fieldset"><legend class="ec-legend" data-ec-part="legend">Dados gerais</legend><div class="ec-field" data-ec="field"><label class="ec-label" data-ec-part="label">Nome:</label><input class="ec-input ec-w-m" data-ec-part="input" type="text" value="" /></div></fieldset>',
    css: join(css.base, css.row, css.fieldset),
  },
  {
    id: 'ec-grid',
    label: 'Grade (tabela)',
    category: ECIDADE_CATEGORY,
    icon: '▦',
    html: '<table class="ec-grid" data-ec="grid"><thead><tr data-ec-part="header"><th>Código</th><th>Descrição</th><th>Valor</th></tr></thead><tbody><tr data-ec-part="row"><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr><tr data-ec-part="row"><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr><tr data-ec-part="row"><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table>',
    css: join(css.base, css.grid),
  },
  {
    id: 'ec-tabs',
    label: 'Abas',
    category: ECIDADE_CATEGORY,
    icon: '⊟',
    html: '<div class="ec-tabs" data-ec="tabs"><div class="ec-tabs-head" data-ec-part="header"><span class="ec-tab ec-tab-active" data-ec-part="tab">Dados</span><span class="ec-tab" data-ec-part="tab">Itens</span><span class="ec-tab" data-ec-part="tab">Histórico</span></div><div class="ec-tabs-body" data-ec-part="panel"><div class="ec-field" data-ec="field"><label class="ec-label" data-ec-part="label">Campo:</label><input class="ec-input ec-w-m" data-ec-part="input" type="text" value="" /></div></div></div>',
    css: join(css.base, css.row, css.tabs),
  },
  {
    id: 'ec-status',
    label: 'Barra de status',
    category: ECIDADE_CATEGORY,
    icon: '▁',
    html: '<div class="ec-status" data-ec="status-bar"><span data-ec-part="text">Instituição: Prefeitura Municipal</span><span data-ec-part="text">Departamento: Finanças</span></div>',
    css: join(css.base, css.status),
  },
  {
    id: 'ec-msg',
    label: 'Mensagem',
    category: ECIDADE_CATEGORY,
    icon: 'ⓘ',
    html: '<div class="ec-msg ec-msg-info" data-ec="message"><span class="ec-msg-icon">i</span><span class="ec-msg-text" data-ec-part="text">Operação realizada com sucesso.</span></div>',
    css: join(css.base, css.msg),
  },
];

/** The whole e-Cidade stylesheet (used by the editor canvas defaults and the tests). */
export const ECIDADE_CSS = join(...Object.values(css));

/** `html` + a `<style>` with the block CSS: what the editor parses when the block is dropped. */
export function blockContent(block: { html: string; css: string }): string {
  return block.css.trim() ? `${block.html}<style>${block.css}</style>` : block.html;
}

/** Generic building blocks (not e-Cidade specific). */
export const BASIC_CATEGORY = 'Básicos';

export const BASIC_BLOCKS: BlockDef[] = [
  {
    id: 'pb-text',
    label: 'Texto',
    category: BASIC_CATEGORY,
    icon: 'T',
    html: '<p class="pb-text">Texto</p>',
    css: '.pb-text{font:11px Arial,Helvetica,sans-serif;color:#000;margin:4px 0}',
  },
  {
    id: 'pb-box',
    label: 'Caixa',
    category: BASIC_CATEGORY,
    icon: '□',
    html: '<div class="pb-box"></div>',
    css: '.pb-box{padding:8px;min-height:48px;width:fit-content;min-width:120px;box-sizing:border-box}',
  },
  {
    id: 'pb-line',
    label: 'Linha',
    category: BASIC_CATEGORY,
    icon: '―',
    html: '<hr class="pb-line" />',
    css: '.pb-line{border:0;border-top:1px solid #888888;margin:6px 0}',
  },
];
