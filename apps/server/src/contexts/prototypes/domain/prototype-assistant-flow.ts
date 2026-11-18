import {
  PROTOTYPE_ASSISTANT_LIMITS,
  PROTOTYPE_LIMITS,
  type PrototypeAssistantAction,
  type PrototypeAssistantSelection,
} from '@thinkflow/shared';
import { DomainError } from '../../../shared/kernel/errors';
import { sanitizeHtml, sanitizeStylesheet } from './html-sanitizer';
import {
  parseHtml,
  serializeNodes,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from './html-tree';
import {
  collapseWhitespace,
  ImageVault,
  placeholdersIn,
  restoreImagesInCss,
  restoreImagesInTree,
  stripImagesFromCss,
  stripImagesFromTree,
  trimCss,
  vocabularyOf,
} from './prototype-assistant-compact';
import { type ParsedAnswer } from './prototype-assistant-prompt';
import { getSystemProfile, type PrototypeSystemProfile } from './system-profiles';
import {
  locateSelection,
  parseScreen,
  spliceSelection,
  type Located,
} from './prototype-assistant-selection';
import {
  changeRatio,
  collectUrls,
  isBlankBody,
  isLocalAction,
  LOCAL_CHANGE_LIMIT,
  riskWarnings,
  stripCssRisks,
  stripRisks,
  type RiskReport,
} from './prototype-assistant-validate';

/*
 * The deterministic parts around the model call: what is sent (compacted, trimmed, size-checked)
 * and how the answer is turned back into a full prototype (images restored, risks stripped,
 * component spliced into the untouched rest of the screen, sanitized).
 */

export interface AssistantInput {
  action: PrototypeAssistantAction;
  selection?: PrototypeAssistantSelection | undefined;
  html: string;
  css: string;
}

export interface Prepared {
  mode: 'screen' | 'component';
  /** Original screen tree (the component is spliced into it). */
  body: HtmlElement;
  located: Located | null;
  send: { html: string; css: string; breadcrumb?: string };
  vault: ImageVault;
  /** Placeholders of the markup that went to the model. */
  sentImages: Set<number>;
  /** What the markup that was sent looks like (for the change ratio). */
  before: HtmlNode[];
  /** External addresses the prototype already had (those may stay). */
  known: Set<string>;
  blank: boolean;
}

const MAX = PROTOTYPE_ASSISTANT_LIMITS.maxModelChars;
const kchars = (n: number) => `${Math.round(n / 1000)} mil`;

export function prepareRequest(input: AssistantInput): Prepared {
  const body = parseScreen(input.html);
  const known = collectUrls([body], input.css);

  let located: Located | null = null;
  if (input.selection) {
    const found = locateSelection(body, input.selection);
    if (found === null)
      throw new DomainError(
        'Não encontrei o componente selecionado na tela. Selecione-o de novo no editor e tente outra vez.',
        'prototype_assistant_selection',
        400,
      );
    if (found !== 'body') located = found;
  }
  const mode = located ? 'component' : 'screen';
  const target: HtmlNode = located ? located.element : body;

  const vault = new ImageVault();
  const clone = structuredClone([target]);
  stripImagesFromTree(clone, vault);
  collapseWhitespace(clone);
  const html = serializeNodes(clone);
  const strippedCss = stripImagesFromCss(input.css, vault);

  // the whole screen's vocabulary is the best guide for a component's CSS; fall back to its own
  let css = trimCss(strippedCss, vocabularyOf(mode === 'component' ? [body] : clone));
  if (mode === 'component' && html.length + css.length > MAX)
    css = trimCss(strippedCss, vocabularyOf(clone));

  const size = html.length + css.length;
  if (size > MAX) {
    throw new DomainError(
      mode === 'component'
        ? `O componente selecionado ainda é grande demais para a IA (${kchars(size)} caracteres; o limite é ${kchars(MAX)}). Selecione uma parte menor.`
        : `A tela é grande demais para a IA (${kchars(size)} caracteres; o limite é ${kchars(MAX)}). Selecione um componente no editor (um fieldset, uma tabela…) e peça a alteração só nele.`,
      'prototype_assistant_too_large',
      413,
    );
  }

  return {
    mode,
    body,
    located,
    send: {
      html,
      css,
      ...(located ? { breadcrumb: `${located.breadcrumb} > …` } : {}),
    },
    vault,
    sentImages: placeholdersIn(clone),
    before: clone,
    known,
    blank: mode === 'screen' && isBlankBody(body),
  };
}

export type ApplyResult =
  { ok: true; html: string; css: string; warnings: string[] } | { ok: false; issues: string[] };

/** Turns the model's answer into the full proposed prototype (or the issues to retry with). */
export function applyAnswer(
  prepared: Prepared,
  input: AssistantInput,
  answer: ParsedAnswer,
  profile: PrototypeSystemProfile = getSystemProfile(),
): ApplyResult {
  const warnings: string[] = [];
  const parsed = parseHtml(answer.html);
  const modelBody = parsed.find((n): n is HtmlElement => n.type === 'element' && n.tag === 'body');

  let nodes: HtmlNode[];
  let newBody: HtmlElement | null = null;
  if (prepared.mode === 'screen') {
    newBody = modelBody ?? {
      type: 'element',
      tag: 'body',
      attrs: structuredClone(prepared.body.attrs),
      children: parsed,
    };
    nodes = [newBody];
  } else {
    nodes = modelBody ? modelBody.children : parsed;
    if (!nodes.some((n) => n.type === 'element' || (n.type === 'text' && n.text.trim())))
      return { ok: false, issues: ['O componente devolvido está vazio.'] };
  }

  const { restored, unknown } = restoreImagesInTree(nodes, prepared.vault);
  const risk: RiskReport = { scripts: 0, handlers: 0, external: 0 };
  stripRisks(nodes, prepared.known, risk);
  const newCss = stripCssRisks(
    restoreImagesInCss(answer.css, prepared.vault),
    prepared.known,
    risk,
  );

  if (newBody && isBlankBody(newBody))
    return { ok: false, issues: ['A tela devolvida está vazia; devolva a tela completa.'] };

  warnings.push(...riskWarnings(risk));
  if (unknown > 0)
    warnings.push('A IA citou imagens que não existem; os marcadores inventados foram ignorados.');
  const lost = [...prepared.sentImages].filter((n) => !restored.has(n)).length;
  if (lost > 0)
    warnings.push(`A IA removeu ${lost} imagem(ns) da tela; confira o "Depois" antes de aplicar.`);

  if (isLocalAction(input.action)) {
    const ratio = changeRatio(prepared.before, nodes);
    const limit = LOCAL_CHANGE_LIMIT[prepared.mode];
    if (ratio > limit)
      warnings.push(
        `A IA mudou cerca de ${Math.round(ratio * 100)}% ${prepared.mode === 'component' ? 'do componente' : 'da tela'}, mais do que um ajuste local costuma mexer; confira o "Depois" antes de aplicar.`,
      );
  }

  let finalBody: HtmlElement;
  if (prepared.mode === 'screen') finalBody = newBody!;
  else {
    spliceSelection(prepared.located!, nodes);
    finalBody = prepared.body;
  }

  const html = sanitizeHtml(serializeNodes([finalBody]));
  const needsBase = profile.usesBase(html) && !input.css.includes(profile.baseMarker);
  const css = sanitizeStylesheet(
    [needsBase ? profile.baseCss : '', input.css.trim(), newCss.trim()].filter(Boolean).join('\n'),
  );

  if (html.length + css.length > PROTOTYPE_LIMITS.maxSnapshotBytes)
    throw new DomainError(
      'O resultado da IA ficou grande demais para o protótipo. Peça uma alteração menor.',
      'prototype_assistant_result_too_large',
      502,
    );
  if (
    textContent(finalBody).trim() === '' &&
    !/<(?:input|img|table|select|textarea|button)/i.test(html)
  )
    return { ok: false, issues: ['A tela devolvida não tem conteúdo.'] };
  return { ok: true, html, css, warnings };
}
