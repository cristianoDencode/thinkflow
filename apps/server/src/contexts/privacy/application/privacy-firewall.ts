import type { PrivacySettings } from '@thinkflow/shared';
import type { RoutableRequest } from '../../routing/domain/types';
import { DEFAULT_MIN_SCORE, detectAll, tokenRanges } from '../domain/detect';
import { PII_KINDS, type PiiKind, type Span } from '../domain/pii';
import type { VaultStore } from '../domain/ports';
import { tokenize } from '../domain/tokenizer';
import { InMemoryVault, type Vault, type VaultEntry } from '../domain/vault';

/** A text provider beyond the native detectors (the Presidio sidecar, F5). Spans index into `text`. */
export type ExtraSpansProvider = (text: string) => Promise<Span[]>;

export interface PrivacyFirewallDeps {
  vaults: VaultStore;
  settings: () => PrivacySettings;
  /** Optional async detector merged with the native ones; failures only degrade (native detectors still run). */
  extraSpans?: ExtraSpansProvider;
  /** Hard limit for one `extraSpans` call (default 2.5 s). */
  extraTimeoutMs?: number;
  /** Called once per `protect` when `extraSpans` failed for some text (log it; never with values). */
  onDegraded?: () => void;
}

export interface ProtectResult {
  /** Deep copy of the request with every text leaf tokenized; the input is never mutated. */
  request: RoutableRequest;
  /** Images / audio / documents that went out as they are: the firewall does not read them. */
  imagesUnfiltered: number;
  /** How many spans were replaced, by kind. */
  tokenized: Record<PiiKind, number>;
  /** `extraSpans` failed or timed out for at least one text: only the native detectors ran there. */
  degraded: boolean;
}

/** A piece of text inside the request body that can be rewritten in place. */
interface Leaf {
  text: string;
  set(value: string): void;
}

/** Collects the rewritable text of a request (and counts media that cannot be filtered). */
class Collector {
  readonly leaves: Leaf[] = [];
  /** Run after all leaves were rewritten (e.g. re-stringify a tool-call arguments JSON). */
  readonly posts: (() => void)[] = [];
  media = 0;

  text(holder: Record<string, unknown> | unknown[], key: string | number): void {
    const h = holder as Record<string | number, unknown>;
    const value = h[key];
    if (typeof value !== 'string' || value.trim() === '') return;
    this.leaves.push({
      text: value,
      set: (v) => {
        h[key] = v;
      },
    });
  }

  /** Every string inside a JSON-like value (object keys are structure, not content). */
  json(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'string') this.text(value, i);
        else this.json(item);
      });
    } else if (isObject(value)) {
      for (const [k, item] of Object.entries(value)) {
        if (typeof item === 'string') this.text(value, k);
        else this.json(item);
      }
    }
  }

  /** A JSON document kept as a string (tool-call arguments): tokenize its values, not its syntax. */
  jsonString(holder: Record<string, unknown>, key: string): void {
    const raw = holder[key];
    if (typeof raw !== 'string' || raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.text(holder, key);
      return;
    }
    if (!isObject(parsed) && !Array.isArray(parsed)) {
      this.text(holder, key);
      return;
    }
    this.json(parsed);
    this.posts.push(() => {
      holder[key] = JSON.stringify(parsed);
    });
  }

  /** Free-text fields of a JSON schema (tool definitions); property names and types stay as they are. */
  schema(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.schema(item);
    } else if (isObject(value)) {
      for (const [k, item] of Object.entries(value)) {
        if (k === 'description' || k === 'title') {
          if (typeof item === 'string') this.text(value, k);
        } else if (k === 'default' || k === 'examples' || k === 'example') {
          if (typeof item === 'string') this.text(value, k);
          else this.json(item);
        } else if (k !== 'enum' && k !== 'const') {
          this.schema(item);
        }
      }
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Plain recursive copy: strings are shared (immutable), so a 30 MB base64 image costs nothing. */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v);
    return out as T;
  }
  return value;
}

/* ------------------------------ OpenAI ------------------------------ */

const OPENAI_MEDIA_PARTS = new Set(['image_url', 'input_audio', 'file', 'image', 'video_url']);

function collectOpenAi(body: Record<string, unknown>, c: Collector): void {
  if (typeof body.instructions === 'string') c.text(body, 'instructions');
  if (typeof body.system === 'string') c.text(body, 'system');
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message)) continue;
      if (typeof message.content === 'string') c.text(message, 'content');
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!isObject(part)) continue;
          if (typeof part.type === 'string' && OPENAI_MEDIA_PARTS.has(part.type)) c.media++;
          else if (typeof part.text === 'string') c.text(part, 'text');
        }
      }
      for (const key of ['reasoning_content', 'reasoning', 'refusal'] as const)
        if (typeof message[key] === 'string') c.text(message, key);
      if (Array.isArray(message.tool_calls)) {
        // only `function.arguments` is read: `extra_content` is opaque,
        // signed data that must reach the provider byte for byte
        for (const call of message.tool_calls) {
          if (isObject(call) && isObject(call.function)) c.jsonString(call.function, 'arguments');
        }
      }
      if (isObject(message.function_call)) c.jsonString(message.function_call, 'arguments');
    }
  }
  collectTools(body.tools, c);
}

/* ----------------------------- Anthropic ---------------------------- */

const ANTHROPIC_MEDIA_BLOCKS = new Set(['image', 'document', 'audio', 'video']);
/** Signed by the provider: rewriting them would invalidate the signature, and the router never restores them. */
const ANTHROPIC_OPAQUE_BLOCKS = new Set(['thinking', 'redacted_thinking']);

function collectAnthropicBlocks(content: unknown, c: Collector): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== 'string') continue;
    if (ANTHROPIC_MEDIA_BLOCKS.has(block.type)) c.media++;
    else if (ANTHROPIC_OPAQUE_BLOCKS.has(block.type)) continue;
    else if (block.type === 'tool_use') c.json(block.input);
    else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') c.text(block, 'content');
      else collectAnthropicBlocks(block.content, c);
    } else if (typeof block.text === 'string') c.text(block, 'text');
  }
}

function collectAnthropic(body: Record<string, unknown>, c: Collector): void {
  if (typeof body.system === 'string') c.text(body, 'system');
  else collectAnthropicBlocks(body.system, c);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message)) continue;
      if (typeof message.content === 'string') c.text(message, 'content');
      else collectAnthropicBlocks(message.content, c);
    }
  }
  collectTools(body.tools, c);
}

function collectTools(tools: unknown, c: Collector): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    if (typeof tool.description === 'string') c.text(tool, 'description');
    if (isObject(tool.function)) {
      if (typeof tool.function.description === 'string') c.text(tool.function, 'description');
      c.schema(tool.function.parameters);
    }
    c.schema(tool.input_schema);
    c.schema(tool.parameters);
  }
}

/* --------------------------- known values --------------------------- */

const DIGIT_KINDS: ReadonlySet<PiiKind> = new Set([
  'CPF',
  'CNPJ',
  'CNS',
  'PIS',
  'TITULO',
  'CNH',
  'RENAVAM',
  'CARTAO',
  'CEP',
  'TELEFONE',
]);
const MIN_KNOWN_LENGTH = 3;
const MIN_KNOWN_DIGITS = 5;
const MAX_KNOWN_ENTRIES = 5000;
const WORD = '[\\p{L}\\p{N}_]';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Finds the values the scope already tokenized (whatever the detectors would say about them), so
 * a value that was tokenized structurally and later restored for display never goes back raw.
 * One regex per vault snapshot: longest values first; digit kinds tolerate any punctuation
 * ("123.456.789-09" = "12345678909"), words are case-insensitive with flexible whitespace.
 */
class KnownValues {
  private readonly regex: RegExp | null;
  private readonly byText = new Map<string, string>();
  private readonly byDigits = new Map<string, string>();

  constructor(entries: Iterable<VaultEntry>) {
    const usable: { pattern: string; length: number }[] = [];
    for (const e of entries) {
      if (usable.length >= MAX_KNOWN_ENTRIES) break;
      const value = e.value.trim();
      if (value.length < MIN_KNOWN_LENGTH) continue;
      if (DIGIT_KINDS.has(e.kind)) {
        const digits = value.replace(/\D/g, '');
        if (digits.length < MIN_KNOWN_DIGITS || this.byDigits.has(digits)) continue;
        this.byDigits.set(digits, e.token);
        usable.push({
          pattern: [...digits].join('[\\s.\\-/()]{0,2}'),
          length: value.length,
        });
      } else {
        const key = squash(value);
        if (this.byText.has(key)) continue;
        this.byText.set(key, e.token);
        usable.push({
          pattern: value.split(/\s+/).map(escapeRe).join('\\s+'),
          length: value.length,
        });
      }
    }
    if (usable.length === 0) {
      this.regex = null;
      return;
    }
    usable.sort((a, b) => b.length - a.length);
    this.regex = new RegExp(
      `(?<!${WORD})(?:${usable.map((u) => u.pattern).join('|')})(?!${WORD})`,
      'giu',
    );
  }

  replace(text: string): string {
    if (!this.regex) return text;
    // never look inside tokens already written in the text
    const protectedRanges = tokenRanges(text);
    let out = '';
    let pos = 0;
    const regex = this.regex;
    regex.lastIndex = 0;
    for (let m = regex.exec(text); m; m = regex.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      if (protectedRanges.some(([a, b]) => start < b && end > a)) continue;
      const token = this.byText.get(squash(m[0])) ?? this.byDigits.get(m[0].replace(/\D/g, ''));
      if (!token) continue;
      out += text.slice(pos, start) + token;
      pos = end;
    }
    return pos === 0 ? text : out + text.slice(pos);
  }
}

/* ------------------------------ firewall ---------------------------- */

const CONCURRENCY = 6;

/**
 * The personal-data firewall of the AI router: every text that would leave for a provider goes
 * through `protect`, which replaces personal data by reversible tokens (`[CPF_1]`) kept in the
 * scope's vault. The router restores the tokens in what comes back (see `restoreStream`).
 */
export class PrivacyFirewall {
  constructor(private readonly deps: PrivacyFirewallDeps) {}

  enabled(): boolean {
    return this.deps.settings().enabled;
  }

  /** The scope's persistent vault, or a throw-away one when the request has no scope. */
  vaultFor(scope?: string): Vault {
    return scope ? this.deps.vaults.forScope(scope) : new InMemoryVault();
  }

  async protect(request: RoutableRequest, vault: Vault): Promise<ProtectResult> {
    const settings = this.deps.settings();
    const minScore = settings.minScore ?? DEFAULT_MIN_SCORE;
    const body = cloneJson(request.body);
    const collector = new Collector();
    if (request.format === 'anthropic') collectAnthropic(body, collector);
    else collectOpenAi(body, collector);

    const tokenized = Object.fromEntries(PII_KINDS.map((k) => [k, 0])) as Record<PiiKind, number>;
    const counting: Vault = {
      tokenFor: (kind, value) => {
        tokenized[kind]++;
        return vault.tokenFor(kind, value);
      },
      valueOf: (token) => vault.valueOf(token),
      entries: () => vault.entries(),
    };

    const known = new KnownValues(vault.entries());
    // phase 1: known values + async detectors (concurrent, no vault writes)
    const prepared = collector.leaves.map((leaf) => known.replace(leaf.text));
    const extras: Span[][] = prepared.map(() => []);
    let degraded = false;
    const extra = this.deps.extraSpans;
    if (extra) {
      let next = 0;
      const worker = async () => {
        while (next < prepared.length) {
          const i = next++;
          const text = prepared[i]!;
          if (text.trim().length < 4) continue;
          try {
            extras[i] = await withTimeout(extra(text), this.deps.extraTimeoutMs ?? 2500);
          } catch {
            degraded = true;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prepared.length) }, worker));
    }
    // phase 2: sequential, so token numbers follow the order of the text
    collector.leaves.forEach((leaf, i) => {
      const text = prepared[i]!;
      const spans = detectAll(text, { minScore, extra: extras[i]! });
      leaf.set(spans.length > 0 ? tokenize(text, counting, spans) : text);
    });
    for (const post of collector.posts) post();
    if (degraded) this.deps.onDegraded?.();

    return {
      request: { ...request, body },
      imagesUnfiltered: collector.media,
      tokenized,
      degraded,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
