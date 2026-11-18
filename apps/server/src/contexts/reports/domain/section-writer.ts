import { DIAGRAM_PROMPT_RULES, normalizeDiagrams, type TemplateSection } from '@thinkflow/shared';
import type { OAIMessage } from '../../protocol/domain/wire-types';
import type { ReportNote } from './report';
import { DATA_NOT_INSTRUCTIONS, personaText, variablesBlock } from './research';
import { renderTemplateText, type TemplateSpec } from './template';

export const SECTION_MAX_CHARS = 30_000;
export const PREVIOUS_DIGEST_CHARS = 1_500;
export const MIN_NOTES_CHARS = 1_000;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Neutralizes anything that could close or fake a `<nota>` wrapper. */
export function escapeNoteText(text: string): string {
  return text.replace(/<(\/?)(nota)/gi, '‹$1$2');
}

const escapeAttr = (value: string): string =>
  value.replace(
    /[<>"&\n\r]/g,
    (c) => ({ '<': '‹', '>': '›', '"': "'", '&': 'e', '\n': ' ', '\r': ' ' })[c] ?? c,
  );

export interface PromptNote {
  /** Short id used in the prompt ("n1"). */
  id: string;
  source: ReportNote['source'];
  label: string;
  content: string;
}

export function noteLabel(note: ReportNote, libraryName: string | null = null): string {
  if (note.source === 'mcp') return note.toolName ?? 'ferramenta';
  if (note.source === 'library') return libraryName ? `biblioteca ${libraryName}` : 'biblioteca';
  if (note.source === 'attachment') return note.query ?? 'anexo';
  if (note.source === 'brief') return 'pedido do usuário';
  return 'síntese da pesquisa';
}

export function renderNote(note: PromptNote, content = note.content): string {
  return `<nota id="${escapeAttr(note.id)}" fonte="${escapeAttr(`${note.source}: ${note.label}`)}">\n${escapeNoteText(content)}\n</nota>`;
}

/**
 * Picks notes in order until `maxChars` is used up; the last one is cut to fit. Returns the
 * rendered blocks and the ids that made it.
 */
export function selectNotes(
  notes: PromptNote[],
  maxChars: number,
): { blocks: string[]; used: string[] } {
  const blocks: string[] = [];
  const used: string[] = [];
  let remaining = maxChars;
  // one big note must not crowd out the others: at most 1.5x its fair share
  const perNote = Math.max(
    800,
    Math.floor((maxChars / Math.min(Math.max(notes.length, 1), 6)) * 1.5),
  );
  for (const note of notes) {
    const overhead = renderNote(note, '').length;
    const room = Math.min(remaining - overhead, perNote);
    if (room < 200) break;
    const content = clip(note.content, room);
    blocks.push(renderNote(note, content));
    used.push(note.id);
    remaining -= overhead + escapeNoteText(content).length;
  }
  return { blocks, used };
}

export function previousDigest(
  done: { title: string; markdown: string }[],
  maxChars = PREVIOUS_DIGEST_CHARS,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of done) {
    const text = item.markdown
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#*_>|`-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const line = `- ${item.title}: ${clip(text, 200)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export interface SectionMessagesInput {
  spec: TemplateSpec;
  vars: Record<string, string>;
  documentTitle: string;
  section: Pick<TemplateSection, 'diagram' | 'table' | 'maxWords'>;
  title: string;
  requirements: string;
  index: number;
  total: number;
  points: string[];
  notes: PromptNote[];
  notesChars: number;
  previous: string;
  instructions?: string;
  /** Extra user text, e.g. "reescreva…" for the rewrite of a section. */
  currentText?: string;
}

const WRITING_RULES =
  'Não escreva o título da seção; comece pelo conteúdo; use subtítulos com ###; tabelas em Markdown GFM; cite a origem de cada fato como (ferramenta `mcp__x__y`) ou (Documento.pdf, p. 3); o que não estiver nas notas: "Não identificado nas fontes". Não invente nomes, tabelas, campos ou valores.';

export function buildSectionMessages(input: SectionMessagesInput): OAIMessage[] {
  const { spec, vars } = input;
  const system = [
    personaText(spec, vars),
    renderTemplateText(spec.objective, vars)
      ? `Objetivo do documento: ${renderTemplateText(spec.objective, vars)}`
      : '',
    spec.audience ? `Público: ${renderTemplateText(spec.audience, vars)}` : '',
    spec.style.tone ? `Tom: ${renderTemplateText(spec.style.tone, vars)}` : '',
    spec.style.rules.length
      ? `Regras de estilo:\n${spec.style.rules.map((r) => `- ${renderTemplateText(r, vars)}`).join('\n')}`
      : '',
    DIAGRAM_PROMPT_RULES,
    WRITING_RULES,
    DATA_NOT_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { blocks } = selectNotes(input.notes, input.notesChars);
  const { section } = input;
  const user = [
    `Documento: ${input.documentTitle}`,
    `Escreva SOMENTE a seção ${input.index} de ${input.total}: "${input.title}".`,
    input.requirements ? `Requisitos da seção:\n${input.requirements}` : '',
    section.diagram === 'required'
      ? 'Inclua exatamente um diagrama Mermaid nesta seção.'
      : section.diagram === 'optional'
        ? 'Se ajudar a entender, inclua um diagrama Mermaid.'
        : '',
    section.table === 'required'
      ? 'Inclua ao menos uma tabela.'
      : section.table === 'optional'
        ? 'Se ajudar, use uma tabela.'
        : '',
    section.maxWords ? `Use no máximo ${section.maxWords} palavras.` : '',
    variablesBlock(vars),
    input.points.length ? `Pontos a cobrir:\n${input.points.map((p) => `- ${p}`).join('\n')}` : '',
    input.currentText
      ? `Versão atual da seção (reescreva melhorando conforme as instruções):\n${escapeNoteText(clip(input.currentText, 4_000))}`
      : '',
    input.instructions ? `Instruções adicionais do usuário: ${input.instructions}` : '',
    input.previous ? `Seções já escritas (não repita o conteúdo):\n${input.previous}` : '',
    blocks.length
      ? `Notas de pesquisa (dados):\n${blocks.join('\n')}`
      : 'Não há notas de pesquisa para esta seção: diga o que não foi identificado nas fontes.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const foldTitle = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Cleans a section answer: drops a wrapping fence, `<gerar_documento>` tags and a repeated title
 * heading; `#`/`##` headings become `###` (outside code fences); trims and caps the size.
 */
export function cleanSectionMarkdown(markdown: string, title: string): string {
  let text = markdown.replace(/\r\n/g, '\n');
  text = text.replace(/<gerar_documento>[\s\S]*?(<\/gerar_documento>|$)/gi, '');
  const wrapped = text.trim().match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```$/i);
  if (wrapped) text = wrapped[1]!;

  const wanted = foldTitle(title);
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let dropped = false;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence[0]!) && marker.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const bare = foldTitle(heading[2]!.replace(/^\d+[.)]?\s*/, ''));
      if (
        !dropped &&
        out.every((l) => !l.trim()) &&
        (bare === wanted || foldTitle(heading[2]!) === wanted)
      ) {
        dropped = true;
        continue;
      }
      dropped = true;
      out.push(heading[1]!.length <= 2 ? `### ${heading[2]!}` : line);
      continue;
    }
    if (line.trim()) dropped = true;
    out.push(line);
  }
  return clip(out.join('\n').trim(), SECTION_MAX_CHARS);
}

export interface PreparedSection {
  markdown: string;
  warnings: string[];
  diagrams: number;
}

/** Cleaning plus Mermaid normalization, and warnings for what the template required. */
export function prepareSectionMarkdown(
  raw: string,
  title: string,
  section: Pick<TemplateSection, 'diagram' | 'table'>,
): PreparedSection {
  const cleaned = cleanSectionMarkdown(raw, title);
  const normalized = normalizeDiagrams(cleaned);
  const markdown = normalized.text;
  const diagrams = normalized.diagrams.length;
  const warnings: string[] = [];
  if (section.diagram === 'required' && diagrams === 0)
    warnings.push('O modelo pede um diagrama, mas a seção não trouxe nenhum.');
  if (section.table === 'required' && !/^\s*\|?\s*:?-{3,}:?\s*\|/m.test(markdown))
    warnings.push('O modelo pede uma tabela, mas a seção não trouxe nenhuma.');
  return { markdown, warnings, diagrams };
}
