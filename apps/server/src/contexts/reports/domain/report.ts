import type {
  ReportMetaDto,
  ReportSettings,
  ReportSourceDto,
  ReportStatus,
  TemplateKind,
  TemplateSpec,
} from '@thinkflow/shared';

export type { ReportStatus, ReportSettings };

/** Statuses in which a job exists (queued, running or waiting to be resumed after a restart). */
export const ACTIVE_STATUSES: readonly ReportStatus[] = [
  'queued',
  'researching',
  'outlining',
  'writing',
  'assembling',
];

export function isActive(status: ReportStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminal(status: ReportStatus): boolean {
  return !isActive(status);
}

/** What the background job does when it runs: a whole generation or the rewrite of one section. */
export type ReportJobSpec =
  | { type: 'generate' }
  | { type: 'section'; ordinal: number; instructions: string; model: string | null };

export interface ReportProgress {
  phase: ReportStatus;
  current: number;
  total: number;
  label: string;
  /** Pending section rewrite (kept so the job survives a restart). Never exposed in the DTO. */
  job?: Extract<ReportJobSpec, { type: 'section' }>;
}

export interface ResearchStep {
  objective: string;
  /** Sections (1-based) this step is looking for. */
  sections: number[];
}

export interface SectionOutline {
  /** 1-based position in the document. */
  ordinal: number;
  sectionId: string;
  title: string;
  noteIds: string[];
  points: string[];
}

export type SectionStatus = 'pending' | 'writing' | 'done' | 'error';

export interface ReportSection {
  reportId: string;
  ordinal: number;
  title: string;
  requirements: string;
  role: 'section' | 'screen';
  status: SectionStatus;
  markdown: string;
  html: string | null;
  noteIds: string[];
  model: string | null;
  providerId: string | null;
  warnings: string[];
  error: string | null;
  updatedAt: number;
}

export type NoteSource = 'mcp' | 'library' | 'attachment' | 'model' | 'brief';

export interface ReportNote {
  id: string;
  reportId: string;
  /** 0 = inputs (brief, attachments); 1.. = research steps. */
  step: number;
  ordinal: number;
  source: NoteSource;
  toolName: string | null;
  query: string | null;
  /** At most `NOTE_MAX_CHARS`. */
  content: string;
  sectionHints: number[];
  createdAt: number;
}

export const NOTE_MAX_CHARS = 8_000;

export type ReportMeta = ReportMetaDto;

export const emptyMeta = (): ReportMeta => ({
  models: [],
  sources: [],
  warnings: [],
  limits: [],
  diagrams: { total: 0, rendered: 0, repaired: 0, failed: 0, unvalidated: 0 },
  libraryDocuments: [],
  generatedAt: null,
});

export interface Report {
  id: string;
  title: string;
  kind: TemplateKind;
  templateId: string | null;
  templateName: string;
  templateSnapshot: TemplateSpec;
  status: ReportStatus;
  progress: ReportProgress;
  error: string | null;
  failedPhase: ReportStatus | null;
  cancelRequested: boolean;
  model: string;
  variables: Record<string, string>;
  brief: string;
  libraryId: string | null;
  useMcp: boolean;
  conversationId: string | null;
  plan: ResearchStep[] | null;
  researchDone: number;
  outline: SectionOutline[] | null;
  html: string | null;
  markdown: string | null;
  meta: ReportMeta;
  /** Object key of the cached PDF of the current version (or the legacy `<id>.pdf`). */
  pdfKey: string | null;
  pdfAt: number | null;
  /** `artifactVersion(html)`: names the object keys of this version. Null until assembled. */
  htmlHash: string | null;
  /** When the HTML + Markdown copy of `htmlHash` were confirmed in the object store. */
  artifactsStoredAt: number | null;
  /** Failed upload attempts of the current version (reset on success or on a new version). */
  storageAttempts: number;
  /** Backoff: no upload attempt before this time. */
  storageNextAt: number | null;
  /** pt-BR reason of the last failed upload. */
  storageError: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Where the HTML of a report is: still in the staging column, or confirmed in the object store. */
export type ReportStorageState = 'stored' | 'pending' | null;

export function storageState(report: Pick<Report, 'html' | 'htmlHash'>): ReportStorageState {
  if (report.html !== null) return 'pending';
  return report.htmlHash !== null ? 'stored' : null;
}

/** Columns that track the upload of a new version: a fresh document starts without any of them. */
export const NEW_VERSION_STORAGE_STATE = {
  artifactsStoredAt: null,
  storageAttempts: 0,
  storageNextAt: null,
  storageError: null,
} as const satisfies Partial<Report>;

/** Report without the heavy columns (list view). */
export interface ReportListItem extends Omit<
  Report,
  | 'templateSnapshot'
  | 'brief'
  | 'plan'
  | 'outline'
  | 'html'
  | 'markdown'
  | 'pdfKey'
  | 'htmlHash'
  | 'artifactsStoredAt'
  | 'storageAttempts'
  | 'storageNextAt'
  | 'storageError'
> {
  researchTotal: number | null;
  sectionCount: number;
  hasMarkdown: boolean;
  hasHtml: boolean;
  hasPdf: boolean;
  storage: ReportStorageState;
}

export interface ReportListQuery {
  status?: ReportStatus | undefined;
  kind?: TemplateKind | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

/** Where a resumed job continues, from the saved state. */
export type Phase = 'researching' | 'outlining' | 'writing' | 'assembling';

export function nextPhase(report: Pick<Report, 'plan' | 'researchDone' | 'outline'>): Phase {
  if (report.plan === null || report.researchDone < report.plan.length) return 'researching';
  if (report.outline === null) return 'outlining';
  return 'writing';
}

export function progressLabel(
  phase: ReportStatus,
  current: number,
  total: number,
  extra = '',
): string {
  switch (phase) {
    case 'queued':
      return 'Na fila…';
    case 'researching':
      return total > 0
        ? `Pesquisando… etapa ${current} de ${total}${extra ? `: ${extra}` : ''}`
        : 'Planejando a pesquisa…';
    case 'outlining':
      return 'Montando o roteiro…';
    case 'writing':
      return `Escrevendo… Tópico ${current} de ${total}${extra ? `: ${extra}` : ''}`;
    case 'assembling':
      return 'Montando documento…';
    case 'done':
      return 'Concluído';
    case 'error':
      return extra ? `Falhou: ${extra}` : 'Falhou';
    case 'canceled':
      return 'Cancelado';
  }
}

export function waitLabel(attempt: number, max: number): string {
  return `Aguardando o limite do provedor (tentativa ${attempt} de ${max})…`;
}

export function toListItem(report: Report, sectionCount: number): ReportListItem {
  const {
    templateSnapshot: _snapshot,
    brief: _brief,
    plan,
    outline: _outline,
    html,
    markdown,
    pdfKey,
    htmlHash,
    artifactsStoredAt: _storedAt,
    storageAttempts: _attempts,
    storageNextAt: _nextAt,
    storageError: _error,
    ...rest
  } = report;
  return {
    ...rest,
    researchTotal: plan ? plan.length : null,
    sectionCount,
    hasMarkdown: markdown !== null,
    hasHtml: html !== null || htmlHash !== null,
    hasPdf: pdfKey !== null,
    storage: storageState({ html, htmlHash }),
  };
}

/** MCP tools, library and attachments the notes came from, with how many results each gave. */
export function sourcesFromNotes(notes: ReportNote[]): ReportSourceDto[] {
  const counts = new Map<string, ReportSourceDto>();
  for (const note of notes) {
    let kind: ReportSourceDto['kind'];
    let name: string;
    if (note.source === 'mcp' || note.source === 'library') {
      kind = note.source;
      name = note.toolName ?? (note.source === 'mcp' ? 'ferramenta' : 'biblioteca');
    } else if (note.source === 'attachment') {
      kind = 'attachment';
      name = note.query ?? 'anexo';
    } else continue;
    const key = `${kind}:${name}`;
    const entry = counts.get(key);
    if (entry) entry.calls += 1;
    else counts.set(key, { kind, name, calls: 1 });
  }
  return [...counts.values()];
}

export function mergeUnique(list: string[], extra: string[], max = 50): string[] {
  const out = [...list];
  for (const item of extra) if (item && !out.includes(item)) out.push(item);
  return out.slice(0, max);
}
