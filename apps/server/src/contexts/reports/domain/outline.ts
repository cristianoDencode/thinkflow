import type { OAIMessage } from '../../protocol/domain/wire-types';
import { PT_STOPWORDS } from '../../library/domain/retrieval';
import { extractJsonObject } from './json-extract';
import type { ReportNote, SectionOutline } from './report';
import { DATA_NOT_INSTRUCTIONS, personaText, variablesBlock } from './research';
import { renderTemplateText, type TemplateSpec } from './template';

export const OUTLINE_MAX_TOKENS = 1_500;
export const NOTES_PER_SECTION = 8;
export const POINTS_PER_SECTION = 8;
const NOTE_INDEX_CHARS = 160;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Lowercase, accent-free word tokens without stopwords (and without 1-2 letter words). */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 3 && !PT_STOPWORDS.has(t));
}

/** Notes that every section receives: the user's brief and attached material. */
export const isCommonNote = (note: ReportNote): boolean =>
  note.source === 'brief' || note.source === 'attachment';

export interface SectionQuery {
  title: string;
  requirements: string;
}

/**
 * Pure lexical ranking: shared tokens with the section's title (weighted) and requirements, plus a
 * bonus when the research step that produced the note was looking for this section.
 * Attachment/brief notes are always kept first; ties keep the research order.
 */
export function rankNotesForSection(
  section: SectionQuery,
  ordinal: number,
  notes: ReportNote[],
  k = NOTES_PER_SECTION,
): string[] {
  const titleTokens = new Set(tokens(section.title));
  const bodyTokens = new Set(tokens(section.requirements));
  const common = notes.filter(isCommonNote);
  const scored = notes
    .filter((n) => !isCommonNote(n))
    .map((note, position) => {
      const noteTokens = new Set(
        tokens(`${note.query ?? ''} ${note.toolName ?? ''} ${note.content}`),
      );
      let score = 0;
      for (const t of titleTokens) if (noteTokens.has(t)) score += 3;
      for (const t of bodyTokens) if (noteTokens.has(t)) score += 1;
      if (note.sectionHints.includes(ordinal)) score += 5;
      // syntheses condense a whole step: slightly preferred when nothing else separates them
      if (note.source === 'model') score += 0.5;
      return { id: note.id, score, position };
    })
    .sort((a, b) => b.score - a.score || a.position - b.position);
  const ids = [...common.map((n) => n.id), ...scored.map((s) => s.id)];
  return ids.slice(0, Math.max(k, common.length));
}

/** Short ids ("n1", "n2"…) the model can cite without copying UUIDs. */
export function noteAliases(notes: ReportNote[]): Map<string, string> {
  return new Map(notes.map((note, i) => [`n${i + 1}`, note.id]));
}

export interface OutlineInput {
  spec: TemplateSpec;
  vars: Record<string, string>;
  notes: ReportNote[];
  /** Characters available for the note index. */
  indexChars: number;
}

export function buildOutlineMessages(input: OutlineInput, parseError?: string): OAIMessage[] {
  const { spec, vars, notes } = input;
  const sections = spec.sections.map((s, i) => {
    const req = renderTemplateText(s.requirements, vars).replace(/\s+/g, ' ').trim();
    return `${i + 1}. ${renderTemplateText(s.title, vars)}${req ? ` — ${clip(req, 200)}` : ''}`;
  });
  const lines: string[] = [];
  let used = 0;
  notes.forEach((note, i) => {
    const line = `n${i + 1} [${note.toolName ?? note.source}] ${clip(note.content.replace(/\s+/g, ' ').trim(), NOTE_INDEX_CHARS)}`;
    if (used + line.length + 1 > input.indexChars) return;
    lines.push(line);
    used += line.length + 1;
  });
  const user = [
    'Monte o roteiro do documento: para cada seção, escolha as notas de pesquisa que a sustentam e os pontos principais a cobrir.',
    variablesBlock(vars),
    `Seções:\n${sections.join('\n')}`,
    lines.length
      ? `Índice das notas (id, origem, início):\n${lines.join('\n')}`
      : 'Não há notas de pesquisa.',
    `Para cada seção escolha até ${NOTES_PER_SECTION} notas e até ${POINTS_PER_SECTION} pontos curtos.`,
    'Responda SOMENTE com JSON, sem texto extra: {"secoes":[{"n":1,"notas":["n1","n4"],"pontos":["…"]}]}',
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

export type OutlineParse =
  | { ok: true; sections: Map<number, { noteIds: string[]; points: string[] }> }
  | { ok: false; error: string };

export function parseOutline(
  answer: string,
  sectionCount: number,
  aliases: Map<string, string>,
): OutlineParse {
  const json = extractJsonObject(answer);
  if (!json) return { ok: false, error: 'JSON inválido' };
  const raw = json.secoes ?? json.sections;
  if (!Array.isArray(raw)) return { ok: false, error: 'campo "secoes" ausente' };
  const sections = new Map<number, { noteIds: string[]; points: string[] }>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const n = Math.trunc(Number(entry.n));
    if (!(n >= 1 && n <= sectionCount) || sections.has(n)) continue;
    const noteIds = [
      ...new Set(
        (Array.isArray(entry.notas) ? entry.notas : [])
          .map((id) => aliases.get(String(id).trim().toLowerCase()))
          .filter((id): id is string => !!id),
      ),
    ].slice(0, NOTES_PER_SECTION);
    const points = (Array.isArray(entry.pontos) ? entry.pontos : [])
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean)
      .slice(0, POINTS_PER_SECTION)
      .map((p) => clip(p, 300));
    sections.set(n, { noteIds, points });
  }
  return sections.size ? { ok: true, sections } : { ok: false, error: 'nenhuma seção válida' };
}

/**
 * Final outline: the model's picks when valid, ranked notes otherwise (per section), and the
 * brief/attachment notes always attached.
 */
export function buildOutline(
  spec: TemplateSpec,
  vars: Record<string, string>,
  notes: ReportNote[],
  parsed: OutlineParse | null,
): SectionOutline[] {
  const common = notes.filter(isCommonNote).map((n) => n.id);
  const known = new Set(notes.map((n) => n.id));
  return spec.sections.map((section, i) => {
    const ordinal = i + 1;
    const title = renderTemplateText(section.title, vars);
    const picked = parsed?.ok ? parsed.sections.get(ordinal) : undefined;
    const ranked = rankNotesForSection(
      { title, requirements: renderTemplateText(section.requirements, vars) },
      ordinal,
      notes,
    );
    const noteIds = [...new Set([...common, ...(picked?.noteIds.length ? picked.noteIds : ranked)])]
      .filter((id) => known.has(id))
      .slice(0, Math.max(NOTES_PER_SECTION, common.length));
    return { ordinal, sectionId: section.id, title, noteIds, points: picked?.points ?? [] };
  });
}
