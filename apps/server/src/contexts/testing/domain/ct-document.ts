/*
 * "Caso de Teste CT": a standard test-case document (header table, analysis, acceptance
 * criteria per use case with text / annotated screenshots / SQL, and a version table).
 *
 * This file is the pure model: types, limits, defaults and small builders shared by the DOCX,
 * HTML and PDF renderers. The zod schema that validates untrusted input lives next to the use
 * cases (`application/ct-document-schema.ts`) because the domain layer may not import npm
 * packages (see .dependency-cruiser.cjs). Both are meant to move to `packages/shared`.
 */

export const CT_LIMITS = {
  maxFieldChars: 300,
  maxTitleChars: 300,
  maxContextChars: 20_000,
  maxTextChars: 20_000,
  maxUseCases: 100,
  maxItemsPerUseCase: 500,
  maxVersions: 100,
  maxKeyChars: 300,
  maxImagePixels: 30_000,
} as const;

export const CT_DEFAULT_ANALYSIS_TITLE = 'Análise';
export const CT_DEFAULT_PRIORITY = 'Normal';
export const CT_DEFAULT_STATUS = 'Finalizado';
export const CT_FIRST_VERSION = '1.0';
export const CT_FIRST_VERSION_DESCRIPTION = 'Criação do documento';
/** Statuses offered by the editor (the field itself is free text). */
export const CT_STATUS_SUGGESTIONS = [
  'Pendente',
  'Em andamento',
  'Finalizado',
  'Reprovado',
] as const;

export interface CtTextItem {
  kind: 'text';
  text: string;
}

export interface CtImageItem {
  kind: 'image';
  /** Object key of the (annotated) screenshot; resolved by the renderers' image lookup. */
  key: string;
  /** Natural size in pixels (used for the aspect ratio only). */
  width: number;
  height: number;
  caption?: string;
}

export interface CtCodeItem {
  kind: 'code';
  text: string;
}

export type CtItem = CtTextItem | CtImageItem | CtCodeItem;

export interface CtUseCase {
  /** Default: "Caso de Uso N" (see `ctUseCaseTitle`). */
  title?: string;
  status: string;
  items: CtItem[];
}

export interface CtVersion {
  version: string;
  date: string;
  description: string;
  author: string;
}

export interface CtDocument {
  title: string;
  ticketId: string;
  priority: string;
  /** May hold several lines ("Financeiro / Empenho\nPatrimonial / Protocolo"). */
  systemModule: string;
  author: string;
  /** Heading of section 2 ("Análise" or, e.g., "Descrição da Demanda"). */
  analysisTitle: string;
  /** "2.1. Contexto": free text, line breaks preserved. */
  context: string;
  useCases: CtUseCase[];
  versions: CtVersion[];
}

/** "dd/mm/aaaa" in the given time zone (default America/Sao_Paulo). */
export function formatCtDate(date: Date, timeZone = 'America/Sao_Paulo'): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('day')}/${pick('month')}/${pick('year')}`;
}

export function emptyCtUseCase(): CtUseCase {
  return { status: CT_DEFAULT_STATUS, items: [] };
}

/** A blank document with the first row of the version table filled in. */
export function createCtDocument(
  init: Partial<CtDocument> = {},
  now: Date = new Date(),
): CtDocument {
  const author = init.author ?? '';
  return {
    title: '',
    ticketId: '',
    priority: CT_DEFAULT_PRIORITY,
    systemModule: '',
    author,
    analysisTitle: CT_DEFAULT_ANALYSIS_TITLE,
    context: '',
    useCases: [],
    versions: [
      {
        version: CT_FIRST_VERSION,
        date: formatCtDate(now),
        description: CT_FIRST_VERSION_DESCRIPTION,
        author,
      },
    ],
    ...init,
  };
}

/** Title shown in the use case header: the custom one, else "Caso de Uso N" (1-based). */
export function ctUseCaseTitle(useCase: CtUseCase, index: number): string {
  const custom = useCase.title?.trim();
  return custom ? custom : `Caso de Uso ${index + 1}`;
}

/** The analysis section heading, falling back to the default when blank. */
export function ctAnalysisTitle(doc: Pick<CtDocument, 'analysisTitle'>): string {
  return doc.analysisTitle.trim() || CT_DEFAULT_ANALYSIS_TITLE;
}

/** Distinct image keys referenced by the document, in reading order. */
export function ctImageKeys(doc: CtDocument): string[] {
  const keys = new Set<string>();
  for (const useCase of doc.useCases) {
    for (const item of useCase.items) if (item.kind === 'image') keys.add(item.key);
  }
  return [...keys];
}

/** Image keys that the lookup cannot resolve (the renderers throw `CtImageMissingError`). */
export function ctMissingImageKeys(doc: CtDocument, has: (key: string) => boolean): string[] {
  return ctImageKeys(doc).filter((key) => !has(key));
}

export class CtImageMissingError extends Error {
  constructor(readonly keys: string[]) {
    super(`Imagem não encontrada para o documento: ${keys.join(', ')}`);
    this.name = 'CtImageMissingError';
  }
}

/** Lines of a free text field; "\r\n" and "\r" are normalised, empty lines kept. */
export function ctLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Size that fits `maxWidth` keeping the aspect ratio (always fills the width, up to `maxHeight`,
 * so annotated screenshots span the whole content width like in the template).
 */
export function fitImage(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  let scale = maxWidth / w;
  if (h * scale > maxHeight) scale = maxHeight / h;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
