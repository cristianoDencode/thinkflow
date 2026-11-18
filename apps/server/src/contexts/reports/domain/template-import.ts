import {
  TEMPLATE_LIMITS,
  placeholdersIn,
  templateInputSchema,
  templateKindSchema,
  templateLayoutSchema,
  type TemplateInput,
  type TemplateKind,
} from '@thinkflow/shared';

/** Loose JSON in, a valid `TemplateInput` out (or the validation issues). */
export type CoerceResult = { ok: true; draft: TemplateInput } | { ok: false; issues: string[] };

export interface CoerceOptions {
  kind?: TemplateKind;
  name?: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, max: number): string {
  if (typeof v === 'string') return v.trim().slice(0, max).trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [];
  return items
    .map((x) => str(x, maxLen).replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, ''))
    .filter(Boolean)
    .slice(0, maxItems);
}

function flag(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function level(v: unknown): 'none' | 'optional' | 'required' {
  if (v === true) return 'required';
  if (v === 'optional' || v === 'required' || v === 'none') return v;
  return 'none';
}

function ascii(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function slugifyId(text: string, fallback = 'secao'): string {
  const slug = ascii(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
  used.add(id);
  return id;
}

/** A valid variable name: ASCII letters, digits and `_`, not starting with a digit. */
export function toVariableName(text: string): string {
  const name = ascii(text)
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!name) return '';
  return /^[0-9]/.test(name) ? `_${name}`.slice(0, 40) : name;
}

function coerceVariables(raw: unknown): Obj[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Obj[] = [];
  for (const item of raw) {
    const source: Obj = isObj(item) ? item : { name: item };
    const name = toVariableName(str(source.name, 80));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      label: str(source.label, 100) || name,
      description: str(source.description, 500),
      required: flag(source.required, false),
      example: str(source.example, 300),
      defaultValue: str(source.defaultValue ?? source.default, 1000),
    });
    if (out.length >= TEMPLATE_LIMITS.maxVariables) break;
  }
  return out;
}

function coerceSections(raw: unknown): Obj[] {
  if (!Array.isArray(raw)) return [];
  const used = new Set<string>();
  const out: Obj[] = [];
  for (const item of raw) {
    const source: Obj = isObj(item) ? item : { title: item };
    const title = str(source.title ?? source.name, 200);
    if (!title) continue;
    const idText = str(source.id, 60);
    const words = typeof source.maxWords === 'number' ? Math.round(source.maxWords) : null;
    out.push({
      id: uniqueId(slugifyId(idText && idText === slugifyId(idText) ? idText : title), used),
      title,
      requirements: str(source.requirements ?? source.description, 4000),
      diagram: level(source.diagram),
      table: level(source.table),
      maxWords: words !== null && words >= 50 && words <= 5000 ? words : null,
    });
    if (out.length >= TEMPLATE_LIMITS.maxSections) break;
  }
  return out;
}

/**
 * Turns a model's JSON (possibly sloppy: wrong types, missing ids, overlong texts, undeclared
 * `{{x}}`) into a valid template draft. Logos are never imported.
 */
export function coerceTemplateDraft(raw: unknown, options: CoerceOptions = {}): CoerceResult {
  if (!isObj(raw)) return { ok: false, issues: ['A resposta não é um objeto JSON'] };
  const root = isObj(raw.modelo) ? raw.modelo : raw;
  const spec = isObj(root.spec) ? root.spec : root;
  const research = isObj(spec.research) ? spec.research : {};
  const style = isObj(spec.style) ? spec.style : {};
  const layoutRaw = isObj(spec.layout) ? spec.layout : {};

  const parsedKind = templateKindSchema.safeParse(root.kind);
  const kind = options.kind ?? (parsedKind.success ? parsedKind.data : 'report');

  const layoutPick: Obj = {};
  for (const key of ['theme', 'primaryColor', 'accentColor', 'cover', 'toc', 'pageSize'] as const)
    if (key in layoutRaw) layoutPick[key] = layoutRaw[key];
  for (const key of ['coverSubtitle', 'headerText', 'footerText'] as const)
    layoutPick[key] = str(layoutRaw[key], 200);
  const layout = templateLayoutSchema.safeParse(layoutPick);

  const sections = coerceSections(spec.sections);
  const variables = coerceVariables(spec.variables);
  const maxSteps = typeof research.maxSteps === 'number' ? Math.round(research.maxSteps) : 6;

  const candidate = {
    name: str(root.name, 120) || options.name || 'Modelo importado',
    kind,
    description: str(root.description, 500),
    spec: {
      persona: str(spec.persona, 2000),
      objective: str(spec.objective, 4000),
      audience: str(spec.audience, 500),
      titlePattern: str(spec.titlePattern, 300),
      research: {
        useMcp: flag(research.useMcp, false),
        mcpServers: strList(research.mcpServers, 20, 100),
        useLibrary: flag(research.useLibrary, true),
        directives: strList(
          research.directives ?? spec.directives,
          TEMPLATE_LIMITS.maxDirectives,
          1000,
        ),
        maxSteps: Math.min(20, Math.max(1, maxSteps)),
      },
      sections,
      style: { tone: str(style.tone, 300), rules: strList(style.rules, 30, 500) },
      variables,
      intakeQuestions: strList(spec.intakeQuestions, 10, 500),
      layout: layout.success ? layout.data : templateLayoutSchema.parse({}),
    },
  };

  // declare every `{{x}}` the model used but forgot to list
  const declared = new Set(variables.map((v) => v.name as string));
  const texts = [
    candidate.spec.persona,
    candidate.spec.objective,
    candidate.spec.audience,
    candidate.spec.titlePattern,
    ...candidate.spec.research.directives,
    ...sections.flatMap((s) => [s.title as string, s.requirements as string]),
    candidate.spec.style.tone,
    ...candidate.spec.style.rules,
    ...candidate.spec.intakeQuestions,
    candidate.spec.layout.coverSubtitle,
    candidate.spec.layout.headerText,
    candidate.spec.layout.footerText,
  ];
  for (const text of texts)
    for (const name of placeholdersIn(text))
      if (!declared.has(name) && variables.length < TEMPLATE_LIMITS.maxVariables) {
        declared.add(name);
        variables.push({
          name,
          label: name,
          description: '',
          required: false,
          example: '',
          defaultValue: '',
        });
      }

  const parsed = templateInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, draft: parsed.data };
  return {
    ok: false,
    issues: [...new Set(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))],
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Deterministic import: structure detected from the text of a prompt                          */
/* ------------------------------------------------------------------------------------------ */

const NUMBERED = /^ {0,3}(?:#{1,4}\s*)?(?:\*\*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const MD_HEADING = /^ {0,3}#{2,4}\s+(.+?)\s*#*\s*$/;
const STOP_LINE =
  /^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:Regras|Restri[çc][õo]es|Tom\b|Estilo|Observa[çc][õo]es|Importante|Formato de sa[íi]da)/i;
const SECTIONS_ANCHOR =
  /estrutura|se[çc][õo]es|t[óo]picos|cap[ií]tulos|deve conter|contenha|conter/i;

const cleanTitle = (text: string) =>
  text
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/[:：]\s*$/, '')
    .trim();

interface Marker {
  line: number;
  title: string;
}

/** The longest 1,2,3… run of numbered lines (a restart at 1 belongs to another list). */
function numberedRun(lines: string[]): Marker[] {
  const found: { line: number; num: number; title: string }[] = [];
  lines.forEach((text, line) => {
    const m = NUMBERED.exec(text);
    if (m) found.push({ line, num: Number(m[1]), title: m[2]! });
  });
  let best: Marker[] = [];
  let bestScore = 0;
  found.forEach((start, i) => {
    if (start.num !== 1) return;
    const run: Marker[] = [{ line: start.line, title: start.title }];
    let expected = 2;
    for (const next of found.slice(i + 1)) {
      if (next.num === expected) {
        run.push({ line: next.line, title: next.title });
        expected++;
      }
    }
    if (run.length < 2) return;
    const anchored = lines
      .slice(Math.max(0, start.line - 3), start.line)
      .some((l) => SECTIONS_ANCHOR.test(l));
    const score = run.length + (anchored ? 3 : 0);
    if (score >= bestScore) {
      best = run;
      bestScore = score;
    }
  });
  return best;
}

function headingRun(lines: string[]): Marker[] {
  const out: Marker[] = [];
  lines.forEach((text, line) => {
    const m = MD_HEADING.exec(text);
    if (m) out.push({ line, title: m[1]! });
  });
  return out.length >= 2 ? out : [];
}

function splitTitle(raw: string): { title: string; rest: string } {
  const text = cleanTitle(raw);
  const m = /^(.{3,80}?)(?:\s+[—–-]\s+|:\s+)(.+)$/.exec(text);
  return m ? { title: m[1]!.trim(), rest: m[2]!.trim() } : { title: text.slice(0, 200), rest: '' };
}

function paragraphs(lines: string[]): string[] {
  return lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function bulletsUnder(lines: string[], heading: RegExp): string[] {
  const idx = lines.findIndex((l) => heading.test(l.replace(/\*\*|#/g, '').trim()));
  if (idx < 0) return [];
  const out: string[] = [];
  let seen = false;
  for (const line of lines.slice(idx + 1)) {
    const bullet = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      out.push(bullet[1]!.trim());
      seen = true;
    } else if (!line.trim()) {
      if (seen) break;
    } else if (seen || /^\s*(?:#{1,4}\s|\*\*)/.test(line)) break;
  }
  return out;
}

/** The most repeated snake_case identifier (e.g. a function name), when it appears at least 3 times. */
function repeatedIdentifier(text: string): string | null {
  const counts = new Map<string, number>();
  for (const m of text.replace(/\{\{[^}]*\}\}/g, '').matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g))
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 2;
  for (const [id, n] of counts) {
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Builds a template draft from the structure of a pasted prompt, without any AI: numbered (or
 * `##`) headings become sections, `{{var}}` placeholders become variables, and a repeated
 * identifier (such as a function name) is promoted to a variable.
 */
export function heuristicTemplateFromPrompt(
  text: string,
  kind: TemplateKind = 'report',
): TemplateInput {
  const identifier = placeholdersIn(text).length === 0 ? repeatedIdentifier(text) : null;
  const source = identifier
    ? text.replace(new RegExp(`\\b${identifier}\\b`, 'g'), '{{termo}}')
    : text;
  const variableName = identifier
    ? /fun[cç][ãa]o|function|pl\s*\/?\s*pgsql/i.test(text)
      ? 'funcao'
      : 'termo'
    : null;
  const normalized =
    variableName && variableName !== 'termo'
      ? source.replace(/\{\{termo\}\}/g, `{{${variableName}}}`)
      : source;

  const lines = normalized.replace(/\r\n?/g, '\n').split('\n');
  let markers = numberedRun(lines);
  if (markers.length < 2) markers = headingRun(lines);

  let stop = lines.length;
  const sections: Obj[] = markers.map((marker, i) => {
    const end = markers[i + 1]?.line ?? lines.length;
    let bodyLines = lines.slice(marker.line + 1, end);
    if (i === markers.length - 1) {
      const cut = bodyLines.findIndex((l) => STOP_LINE.test(l));
      if (cut >= 0) {
        stop = marker.line + 1 + cut;
        bodyLines = bodyLines.slice(0, cut);
      }
    }
    const { title, rest } = splitTitle(marker.title);
    const requirements = [rest, bodyLines.join('\n').trim()]
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 4000);
    return {
      title,
      requirements,
      diagram: /mermaid|diagrama|fluxograma/i.test(`${title} ${requirements}`)
        ? 'required'
        : 'none',
      table: /tabela/i.test(`${title} ${requirements}`) ? 'required' : 'none',
    };
  });

  const firstMarker = markers[0]?.line ?? lines.length;
  const preamble = lines.slice(0, firstMarker);
  const around = [...preamble, ...(markers.length > 0 ? lines.slice(stop) : [])];
  const paras = paragraphs(preamble.filter((l) => !/^\s*#\s/.test(l)));
  const personaIdx = paras.findIndex((p) =>
    /Voc[êe] [ée]|Atue como|Aja como|Seu papel|Papel:|Persona/i.test(p),
  );
  const persona = paras[personaIdx >= 0 ? personaIdx : 0] ?? '';
  const rest = paras.filter((_, i) => i !== (personaIdx >= 0 ? personaIdx : 0));
  const objective = (
    rest.find((p) => /Objetivo|Gere|Produza|Crie|Escreva|Elabore|Explique|tarefa/i.test(p)) ??
    rest[0] ??
    ''
  ).replace(/^Objetivo\s*[:\-–]\s*/i, '');

  const audience =
    /(?:P[úu]blico(?:-alvo)?|Audi[êe]ncia|Leitores?)\s*[:\-–]\s*(.+)/i.exec(normalized)?.[1] ??
    /\bpara ((?:analistas|usu[áa]rios|gestores|desenvolvedores)[^.\n]*)/i.exec(normalized)?.[1] ??
    '';
  const tone = /^\W*Tom(?: de voz)?\s*[:\-–]?\s*(.+)$/im.exec(normalized)?.[1] ?? '';
  const titlePattern =
    /T[íi]tulo(?: do documento)?\s*[:\-–]\s*["“]?(.+?)["”]?\s*$/im.exec(normalized)?.[1] ?? '';
  const heading = /^\s*#\s+(.+?)\s*$/m.exec(normalized)?.[1];

  const directives = bulletsUnder(
    lines,
    /^(?:Diretrizes|Investigue|Colete|Pesquis[ae]|Levante|Passos da pesquisa|Pesquisa)\b.*$/i,
  );
  const rules = bulletsUnder(
    around,
    /^(?:Regras|Restri[çc][õo]es|Importante|Observa[çc][õo]es)\b.*$/i,
  );

  const variables = variableName
    ? [
        {
          name: variableName,
          label: variableName === 'funcao' ? 'Função' : 'Termo principal',
          description: '',
          required: true,
          example: identifier!,
          defaultValue: identifier!,
        },
      ]
    : [];

  const raw = {
    name: heading ? cleanTitle(heading) : '',
    kind,
    description: '',
    spec: {
      persona,
      objective,
      audience,
      titlePattern,
      research: {
        useMcp: /\bMCP\b/.test(normalized),
        useLibrary: true,
        directives,
        maxSteps: Math.min(12, Math.max(4, directives.length + 2)),
      },
      sections:
        sections.length > 0
          ? sections
          : [{ title: 'Conteúdo', requirements: normalized.trim().slice(0, 4000) }],
      style: { tone, rules },
      variables,
    },
  };
  const result = coerceTemplateDraft(raw, { kind, name: 'Modelo importado' });
  if (result.ok) return result.draft;
  // last resort: the minimal structure that always validates
  return templateInputSchema.parse({
    name: 'Modelo importado',
    kind,
    spec: { sections: [{ id: 'conteudo', title: 'Conteúdo' }] },
  });
}

/** Short description of what the heuristic found, to anchor the model's answer. */
export function describeHints(draft: TemplateInput): string {
  const { spec } = draft;
  const lines = [
    `Seções detectadas (${spec.sections.length}): ${spec.sections.map((s, i) => `${i + 1}. ${s.title}`).join(' | ')}`,
  ];
  if (spec.variables.length)
    lines.push(`Variáveis candidatas: ${spec.variables.map((v) => v.name).join(', ')}`);
  if (spec.research.directives.length)
    lines.push(`Diretrizes de pesquisa detectadas: ${spec.research.directives.length}`);
  return lines.join('\n');
}
