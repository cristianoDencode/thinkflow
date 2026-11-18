import type { PrototypeAssistantAction } from '@thinkflow/shared';
import {
  decodeEntities,
  eachElement,
  getAttr,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from './html-tree';

/*
 * Checks of what the model returned: scripts, handlers and external addresses it ADDED are
 * stripped (with a warning), empty screens are refused and an oversized change of a "local"
 * request is flagged. The sanitizer runs afterwards on everything (this file only reports).
 */

const CODE_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'link',
  'meta',
]);
const URL_ATTRS = new Set([
  'src',
  'href',
  'background',
  'poster',
  'action',
  'formaction',
  'data',
  'xlink:href',
]);

/** Drops what browsers ignore inside a URL scheme: controls, spaces and zero-width characters. */
function compactUrl(value: string): string {
  let out = '';
  for (const ch of decodeEntities(value)) {
    const c = ch.codePointAt(0)!;
    const ignored = c <= 0x20 || (c >= 0x7f && c <= 0xa0) || (c >= 0x200b && c <= 0x200f);
    if (!ignored) out += ch;
  }
  return out;
}

/** `http://…`, `https://…` or protocol-relative `//…` (after removing what browsers ignore). */
export function isExternalUrl(value: string): boolean {
  const url = compactUrl(value);
  return /^(?:https?:)?\/\//i.test(url);
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;

/** External addresses already present in the prototype (those may stay). */
export function collectUrls(nodes: readonly HtmlNode[], css: string): Set<string> {
  const urls = new Set<string>();
  const fromCss = (text: string) => {
    for (const m of text.matchAll(CSS_URL)) {
      const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (isExternalUrl(value)) urls.add(value);
    }
  };
  fromCss(css);
  eachElement(nodes, (el) => {
    for (const a of el.attrs) {
      if (URL_ATTRS.has(a.name) && a.value && isExternalUrl(a.value)) urls.add(a.value.trim());
      if (a.name === 'style' && a.value) fromCss(decodeEntities(a.value));
    }
    for (const c of el.children) if (c.type === 'css') fromCss(c.css);
  });
  return urls;
}

export interface RiskReport {
  scripts: number;
  handlers: number;
  external: number;
}

/**
 * Removes (in place) scripts/frames, `on*` handlers, `javascript:` URLs and external addresses
 * that `known` does not already contain. Returns what was found.
 */
export function stripRisks(
  nodes: HtmlNode[],
  known: ReadonlySet<string>,
  risk: RiskReport = { scripts: 0, handlers: 0, external: 0 },
): RiskReport {
  const cleanCss = (css: string): string =>
    css
      .replace(/@import\b[^;{}]*(?:;|(?=\}|$))/gi, () => {
        risk.external++;
        return '';
      })
      .replace(CSS_URL, (whole, dq?: string, sq?: string, bare?: string) => {
        const value = (dq ?? sq ?? bare ?? '').trim();
        if (isExternalUrl(value) && !known.has(value)) {
          risk.external++;
          return 'url("")';
        }
        return whole;
      });

  const walk = (list: HtmlNode[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i]!;
      if (node.type === 'css') {
        node.css = cleanCss(node.css);
        continue;
      }
      if (node.type !== 'element') continue;
      if (CODE_TAGS.has(node.tag)) {
        risk.scripts++;
        list.splice(i, 1);
        continue;
      }
      node.attrs = node.attrs.filter((a) => {
        if (a.name.startsWith('on')) {
          risk.handlers++;
          return false;
        }
        if (a.name === 'style' && a.value) {
          a.value = cleanCss(decodeEntities(a.value)).replace(/&/g, '&amp;').replace(/</g, '&lt;');
          return true;
        }
        if (URL_ATTRS.has(a.name) && a.value) {
          const compact = compactUrl(a.value);
          if (/^(?:java|vb)script:/i.test(compact)) {
            risk.scripts++;
            return false;
          }
          if (isExternalUrl(a.value) && !known.has(a.value.trim())) {
            risk.external++;
            return false;
          }
        }
        return true;
      });
      walk(node.children);
    }
  };
  walk(nodes);
  return risk;
}

/** Stylesheet version of {@link stripRisks}. */
export function stripCssRisks(css: string, known: ReadonlySet<string>, risk: RiskReport): string {
  const holder: HtmlNode[] = [{ type: 'css', css }];
  stripRisks(holder, known, risk);
  return (holder[0] as { css: string }).css;
}

export function riskWarnings(risk: RiskReport): string[] {
  const out: string[] = [];
  if (risk.scripts > 0)
    out.push('A IA incluiu scripts ou elementos executáveis; eles foram removidos.');
  if (risk.handlers > 0)
    out.push('A IA incluiu manipuladores de eventos (onclick etc.); eles foram removidos.');
  if (risk.external > 0)
    out.push('A IA incluiu endereços externos (imagens, links ou CSS); eles foram removidos.');
  return out;
}

/** Whether a body has no visible content (no element besides <style>, no text). */
export function isBlankBody(body: HtmlElement): boolean {
  let content = false;
  eachElement(body.children, (el) => {
    if (el.tag !== 'style') content = true;
  });
  return !content && textContent(body).replace(/\s+/g, '') === '';
}

/** Tokens of a forest: elements (tag + classes) and words. */
function tokens(nodes: readonly HtmlNode[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (t: string) => out.set(t, (out.get(t) ?? 0) + 1);
  const walk = (list: readonly HtmlNode[]) => {
    for (const n of list) {
      if (n.type === 'text') {
        for (const w of n.text.split(/\s+/)) if (w) add(`w:${w}`);
      } else if (n.type === 'element') {
        add(`<${n.tag}.${getAttr(n, 'class') ?? ''}`);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** 0 (identical) … 1 (nothing in common): symmetric difference of element/word multisets. */
export function changeRatio(before: readonly HtmlNode[], after: readonly HtmlNode[]): number {
  const a = tokens(before);
  const b = tokens(after);
  let total = 0;
  let diff = 0;
  for (const [k, n] of a) {
    total += n;
    diff += Math.abs(n - (b.get(k) ?? 0));
  }
  for (const [k, n] of b) {
    total += n;
    if (!a.has(k)) diff += n;
  }
  return total === 0 ? 0 : diff / total;
}

/** Actions that should only touch a little: a big change is flagged. */
const LOCAL_ACTIONS = new Set<PrototypeAssistantAction>(['custom', 'add_field', 'labels']);

export function isLocalAction(action: PrototypeAssistantAction): boolean {
  return LOCAL_ACTIONS.has(action);
}

/** Share of the content that may change in a local request before a warning (screen / component). */
export const LOCAL_CHANGE_LIMIT = { screen: 0.5, component: 0.8 } as const;
