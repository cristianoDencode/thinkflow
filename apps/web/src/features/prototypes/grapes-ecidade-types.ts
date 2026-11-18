import type { Component, Editor, TraitProperties } from 'grapesjs';
import { EC_KIND_ATTR, type EcidadeComponentKind } from '@thinkflow/shared';
import { layerName } from './ec-describe';
import {
  KIND_TYPE,
  attr,
  byTag,
  captionOf,
  descOf,
  draggableRuleFor,
  ecKindOf,
  escapeHtml,
  findAll,
  gridColumns,
  gridRowCount,
  gridSetColumns,
  gridSetRows,
  hasClass,
  inputOf,
  inputsOf,
  isButtonLike,
  isControlRoot,
  itemText,
  itemsOf,
  kindFromMarkup,
  lines,
  partOf,
  partsOf,
  rawTextOf,
  renameItem,
  setAttr,
  setCaption,
  setTextKeepMarkup,
  setTextSegments,
  syncItems,
  tabsActive,
  tabsSetActive,
  tabsSetNames,
  tagOf,
  textOf,
  textSegments,
} from './ec-model';

/*
 * Component types of the e-Cidade components. A component is recognized by `data-ec="<kind>"`
 * (captured screens and the built-in blocks) or, for screens built before the attributes, by the
 * `ec-*` class of the built-in blocks. Each type exposes "traits" (the Propriedades panel) that
 * find their parts by `data-ec-part` first and by the old classes second, and rewrite only the
 * text / attributes involved — never the tags and classes around them — so a captured component
 * keeps its look. They keep no state: values are read from / written to the component tree.
 */

const toNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** The form control the component edits: itself when it is one, else its first input/select. */
const control = (m: Component) => (isControlRoot(m) ? m : inputOf(m));

interface TraitSpec {
  name: string;
  label: string;
  kind?: 'text' | 'number' | 'lines' | 'yesno' | 'select';
  options?: { id: string; label: string }[];
  min?: number;
  max?: number;
  get(m: Component): string | number;
  set(m: Component, value: string): void;
}

const YES_NO = [
  { id: '0', label: 'Não' },
  { id: '1', label: 'Sim' },
];

function toTrait(spec: TraitSpec): TraitProperties {
  const type =
    spec.kind === 'lines'
      ? 'ec-lines'
      : spec.kind === 'yesno' || spec.kind === 'select'
        ? 'select'
        : spec.kind === 'number'
          ? 'number'
          : 'text';
  return {
    type,
    name: spec.name,
    label: spec.label,
    ...(spec.kind === 'yesno'
      ? { options: YES_NO }
      : spec.options
        ? { options: spec.options }
        : {}),
    ...(spec.kind === 'number' ? { min: spec.min, max: spec.max } : {}),
    getValue: ({ component }) => spec.get(component),
    setValue: ({ component, value }) => {
      spec.set(component, String(value ?? ''));
      refreshName(component);
    },
  } as TraitProperties;
}

/** Keeps the Layer manager name ("Lookup: Número do Empenho") in sync with the edited texts. */
function refreshName(m: Component): void {
  const kind = ecKindOf(m);
  if (!kind) return;
  const name = layerName(m, kind);
  if (m.get('name') !== name) m.set('name', name, { avoidStore: true } as never);
}

/* ---- trait builders ------------------------------------------------------------------------ */

/** Label of the component: annotated, `ec-label`, a plain `<label>`; checkboxes fall back to their own text. */
const labelOf = (m: Component): Component | undefined => {
  const kind = ecKindOf(m);
  if (kind === 'radio-group') {
    const annotated = partsOf(m, 'label').filter((c) => attr(c, 'data-ec-part') === 'label');
    return annotated[0] ?? findAll(m, (c) => hasClass(c, 'ec-label'))[0];
  }
  return partOf(m, 'label') ?? (kind === 'checkbox' ? m : undefined);
};

const labelTrait = (name = 'Rótulo'): TraitSpec => ({
  name: 'ec-rotulo',
  label: name,
  get: (m) => textOf(labelOf(m)),
  set: (m, v) => setTextKeepMarkup(labelOf(m), v),
});

const attrTrait = (
  key: string,
  label: string,
  htmlAttr: string,
  pick: (m: Component) => Component | undefined = control,
): TraitSpec => ({
  name: `ec-${key}`,
  label,
  get: (m) => attr(pick(m), htmlAttr),
  set: (m, v) => setAttr(pick(m), htmlAttr, v),
});

const readonlyTrait: TraitSpec = {
  name: 'ec-somente-leitura',
  label: 'Somente leitura',
  kind: 'yesno',
  get: (m) => (control(m)?.getAttributes().readonly !== undefined ? '1' : '0'),
  set: (m, v) => {
    const c = control(m);
    if (!c) return;
    if (v === '1') c.addAttributes({ readonly: 'readonly' });
    else c.removeAttributes('readonly');
    c.removeClass('ec-readonly'); // legacy: the attribute alone carries the look now
  },
};

const FIELD_TRAITS = [
  labelTrait(),
  attrTrait('valor', 'Valor', 'value'),
  attrTrait('placeholder', 'Placeholder', 'placeholder'),
  readonlyTrait,
];

const descTrait: TraitSpec = {
  name: 'ec-descricao',
  label: 'Descrição (texto ao lado)',
  get: (m) => attr(descOf(m), 'value'),
  set: (m, v) => setAttr(descOf(m), 'value', v),
};

const selectOf = (m: Component) => (tagOf(m) === 'select' ? m : byTag(m, 'select')[0]);
const optionsOf = (m: Component) => byTag(m, 'option');

const optionsTrait: TraitSpec = {
  name: 'ec-opcoes',
  label: 'Opções (uma por linha)',
  kind: 'lines',
  get: (m) => optionsOf(m).map(textOf).join('\n'),
  set: (m, v) => {
    const opts = optionsOf(m);
    if (!opts.length) {
      const opt = lines(v)
        .map((o) => `<option>${escapeHtml(o)}</option>`)
        .join('');
      selectOf(m)?.components(opt);
      return;
    }
    syncItems(
      opts.map((o) => [o]),
      lines(v).length ? lines(v) : ['Opção 1'],
      ([opt], name) => setTextKeepMarkup(opt, name),
      ([clone]) => {
        clone?.removeAttributes(['value', 'selected']);
      },
    );
  },
};

const radiosOf = (m: Component) =>
  findAll(m, (c) => tagOf(c) === 'input' && attr(c, 'type').toLowerCase() === 'radio');

const buttonControls = (m: Component) => {
  const found = partsOf(m, 'button');
  return found.length ? found : findAll(m, isButtonLike);
};

/* ---- type definitions ---------------------------------------------------------------------- */

interface EcType {
  kind: EcidadeComponentKind;
  name: string;
  /** Can other blocks be dropped inside it? (only real containers) */
  container?: boolean;
  traits: TraitSpec[];
  /** Removes traits that only make sense for the built-in markup. */
  init?(m: Component): void;
}

const TYPES: EcType[] = [
  { kind: 'field', name: 'Campo', traits: FIELD_TRAITS },
  { kind: 'date', name: 'Data', traits: FIELD_TRAITS },
  {
    kind: 'date-range',
    name: 'Data (intervalo)',
    traits: [
      labelTrait(),
      {
        name: 'ec-data-inicial',
        label: 'Data inicial',
        get: (m) => attr(inputsOf(m)[0], 'value'),
        set: (m, v) => setAttr(inputsOf(m)[0], 'value', v),
      },
      {
        name: 'ec-data-final',
        label: 'Data final',
        get: (m) => attr(inputsOf(m)[1], 'value'),
        set: (m, v) => setAttr(inputsOf(m)[1], 'value', v),
      },
      {
        name: 'ec-separador',
        label: 'Texto entre as datas',
        get: (m) => textOf(partOf(m, 'separator')),
        set: (m, v) => setTextKeepMarkup(partOf(m, 'separator'), v),
      },
    ],
  },
  {
    kind: 'lookup',
    name: 'Lookup',
    traits: [
      labelTrait(),
      attrTrait('valor', 'Código', 'value'),
      attrTrait('placeholder', 'Placeholder', 'placeholder'),
      descTrait,
      readonlyTrait,
    ],
  },
  { kind: 'select', name: 'Combo', traits: [labelTrait(), optionsTrait] },
  {
    kind: 'textarea',
    name: 'Área de texto',
    traits: [
      labelTrait(),
      {
        name: 'ec-texto',
        label: 'Texto',
        kind: 'lines',
        get: (m) => rawTextOf(byTag(m, 'textarea')[0] ?? m),
        set: (m, v) => byTag(m, 'textarea')[0]?.components(escapeHtml(v)),
      },
      attrTrait('placeholder', 'Placeholder', 'placeholder'),
      readonlyTrait,
    ],
  },
  {
    kind: 'checkbox',
    name: 'Caixa de seleção',
    traits: [
      labelTrait('Texto'),
      {
        name: 'ec-marcado',
        label: 'Marcado',
        kind: 'yesno',
        get: (m) => (control(m)?.getAttributes().checked !== undefined ? '1' : '0'),
        set: (m, v) => {
          const c = control(m);
          if (v === '1') c?.addAttributes({ checked: 'checked' });
          else c?.removeAttributes('checked');
        },
      },
    ],
  },
  {
    kind: 'radio-group',
    name: 'Grupo de opções',
    traits: [
      { ...labelTrait('Título'), name: 'ec-titulo' },
      {
        name: 'ec-opcoes',
        label: 'Opções (uma por linha)',
        kind: 'lines',
        get: (m) => itemsOf(m, radiosOf(m)).map(itemText).join('\n'),
        set: (m, v) => {
          const items = itemsOf(m, radiosOf(m));
          if (!items.length) return;
          syncItems(items, lines(v).length ? lines(v) : ['Opção 1'], renameItem, (clone) => {
            clone.forEach((c) =>
              [c, ...findAll(c, () => true)]
                .filter((i) => tagOf(i) === 'input')
                .forEach((i) => i.removeAttributes('checked')),
            );
          });
        },
      },
    ],
  },
  {
    kind: 'button',
    name: 'Botão',
    traits: [
      {
        name: 'ec-texto',
        label: 'Texto',
        get: (m) => captionOf(isButtonLike(m) ? m : (partOf(m, 'button') ?? m)),
        set: (m, v) => setCaption(isButtonLike(m) ? m : (partOf(m, 'button') ?? m), v),
      },
    ],
  },
  {
    kind: 'button-bar',
    name: 'Barra de botões',
    traits: [
      {
        name: 'ec-botoes',
        label: 'Botões (um por linha)',
        kind: 'lines',
        get: (m) => itemsOf(m, buttonControls(m)).map(itemText).join('\n'),
        set: (m, v) => {
          const items = itemsOf(m, buttonControls(m));
          if (items.length) syncItems(items, lines(v).length ? lines(v) : ['Botão'], renameItem);
        },
      },
    ],
  },
  {
    kind: 'fieldset',
    name: 'Grupo com legenda',
    container: true,
    traits: [
      {
        name: 'ec-legenda',
        label: 'Legenda',
        get: (m) => textOf(partOf(m, 'legend')),
        set: (m, v) => setTextKeepMarkup(partOf(m, 'legend'), v),
      },
    ],
  },
  {
    kind: 'grid',
    name: 'Grade',
    traits: [
      {
        name: 'ec-colunas',
        label: 'Colunas (uma por linha)',
        kind: 'lines',
        get: (m) => gridColumns(m).join('\n'),
        set: (m, v) => gridSetColumns(m, lines(v)),
      },
      {
        name: 'ec-linhas',
        label: 'Linhas',
        kind: 'number',
        min: 1,
        max: 200,
        get: (m) => gridRowCount(m),
        set: (m, v) => gridSetRows(m, toNumber(v, gridRowCount(m), 1, 200)),
      },
    ],
  },
  {
    kind: 'tabs',
    name: 'Abas',
    traits: [
      {
        name: 'ec-abas',
        label: 'Abas (uma por linha)',
        kind: 'lines',
        get: (m) => partsOf(m, 'tab').map(textOf).join('\n'),
        set: (m, v) => tabsSetNames(m, lines(v)),
      },
      {
        name: 'ec-aba-ativa',
        label: 'Aba ativa (nº)',
        kind: 'number',
        min: 1,
        max: 20,
        get: (m) => tabsActive(m) + 1,
        set: (m, v) =>
          tabsSetActive(m, toNumber(v, 1, 1, Math.max(1, partsOf(m, 'tab').length)) - 1),
      },
    ],
  },
  {
    kind: 'window-title',
    name: 'Título de janela',
    traits: [
      {
        name: 'ec-titulo',
        label: 'Título',
        get: (m) => textOf(partOf(m, 'title') ?? m),
        set: (m, v) => setTextKeepMarkup(partOf(m, 'title') ?? m, v),
      },
    ],
  },
  {
    kind: 'status-bar',
    name: 'Barra de status',
    traits: [
      {
        name: 'ec-textos',
        label: 'Textos (um por linha)',
        kind: 'lines',
        get: (m) => textSegments(m).join('\n'),
        set: (m, v) => setTextSegments(m, lines(v)),
      },
    ],
  },
  {
    kind: 'message',
    name: 'Mensagem',
    init: (m) => {
      // the type only exists as a built-in `ec-msg-*` class: captured messages keep their own look
      if (!hasClass(m, 'ec-msg')) m.removeTrait('ec-tipo');
    },
    traits: [
      {
        name: 'ec-tipo',
        label: 'Tipo',
        kind: 'select',
        options: [
          { id: 'info', label: 'Informação' },
          { id: 'warn', label: 'Alerta' },
          { id: 'error', label: 'Erro' },
        ],
        get: (m) =>
          hasClass(m, 'ec-msg-warn') ? 'warn' : hasClass(m, 'ec-msg-error') ? 'error' : 'info',
        set: (m, v) => {
          ['info', 'warn', 'error'].forEach((t) => m.removeClass(`ec-msg-${t}`));
          m.addClass(`ec-msg-${v === 'warn' || v === 'error' ? v : 'info'}`);
        },
      },
      {
        name: 'ec-texto',
        label: 'Texto',
        get: (m) => textOf(partOf(m, 'text') ?? m),
        set: (m, v) => setTextKeepMarkup(partOf(m, 'text') ?? m, v),
      },
    ],
  },
];

/** Component type id of each kind (the palette and the tests refer to them). */
export const ECIDADE_TYPE_IDS = TYPES.map((t) => KIND_TYPE[t.kind]);

/** Registers the "textarea" trait input and one component type per e-Cidade kind. */
export function registerEcidadeTypes(editor: Editor): void {
  editor.Traits.addType('ec-lines', {
    createInput() {
      const el = document.createElement('textarea');
      el.rows = 4;
      el.className = 'proto-trait-area';
      return el;
    },
    onUpdate({ elInput, trait }: { elInput: HTMLElement; trait: { getValue(): unknown } }) {
      (elInput as unknown as HTMLTextAreaElement).value = String(trait.getValue() ?? '');
    },
    onEvent({ elInput, trait }: { elInput: HTMLElement; trait: { setValue(v: string): void } }) {
      trait.setValue((elInput as unknown as HTMLTextAreaElement).value);
    },
  } as never);

  for (const def of TYPES) {
    const type = KIND_TYPE[def.kind];
    editor.Components.addType(type, {
      // the attribute wins over the classes (see `kindFromMarkup`)
      isComponent: (el) =>
        el.nodeType === 1 &&
        kindFromMarkup(
          (el as HTMLElement).getAttribute(EC_KIND_ATTR),
          (el as HTMLElement).classList,
          el.tagName,
        ) === def.kind
          ? { type }
          : false,
      model: {
        defaults: {
          name: def.name,
          ...(def.container ? {} : { droppable: false }),
          traits: def.traits.map(toTrait),
        },
        init(this: Component) {
          // the type is matched per element, so the tag is only known per instance: rows, cells and
          // table sections keep the drop rules of GrapesJS' native table types (no `<tr>` inside a `<td>`)
          const rule = draggableRuleFor(tagOf(this));
          if (rule !== true) this.set('draggable', rule as never, { avoidStore: true } as never);
          def.init?.(this);
        },
      },
    });
  }
}
