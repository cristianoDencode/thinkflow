import type { OAITool } from '../../protocol/domain/wire-types';
import type { StoredMessage } from '../../chat/domain/conversation';
import type {
  Report,
  ReportListItem,
  ReportListQuery,
  ReportNote,
  ReportSection,
  ReportStatus,
} from './report';

export interface ReportRepository {
  create(report: Report): Promise<void>;
  findById(id: string): Promise<Report | null>;
  /** Newest first; the heavy columns (html, markdown, snapshot, plan, outline) are not loaded. */
  list(query: ReportListQuery): Promise<ReportListItem[]>;
  /** Applies only the given columns. A report that no longer exists is ignored. */
  update(id: string, patch: Partial<Omit<Report, 'id'>>): Promise<void>;
  delete(id: string): Promise<void>;
  listByStatus(statuses: readonly ReportStatus[]): Promise<Report[]>;
  /** Deletes the oldest finished reports so that at most `keep` remain; returns the deleted reports. */
  pruneOldest(keep: number): Promise<Report[]>;

  /** Inserts the rows that do not exist yet (keeps the ones already written). */
  addSections(sections: ReportSection[]): Promise<void>;
  sections(reportId: string): Promise<ReportSection[]>;
  updateSection(
    reportId: string,
    ordinal: number,
    patch: Partial<Omit<ReportSection, 'reportId' | 'ordinal'>>,
  ): Promise<void>;
  /** Sections left in `writing` by an interrupted run go back to `pending` (`done` when they already have text). */
  resetWritingSections(reportId: string): Promise<void>;

  /* ---- object storage sync (see ReportArtifactSync) ---- */

  /** Ids whose HTML is still in the staging column and whose backoff has expired, oldest first. */
  listStorageDue(now: number, limit: number): Promise<string[]>;
  /** Reports whose HTML is still in the staging column (not yet confirmed in the object store). */
  countStoragePending(): Promise<number>;
  /**
   * Conditional: empties the staging column only if the row still holds the version `hash`.
   * Returns false when another assembly replaced the document (or the report is gone).
   */
  markArtifactsStored(id: string, hash: string, at: number): Promise<boolean>;
  /** Records a failed upload of `hash` and when to try again. */
  markStorageFailed(id: string, hash: string, error: string, nextAt: number): Promise<void>;
  /** Backfill: sets `htmlHash` only if the row has HTML and no hash yet. */
  setHtmlHashIfMissing(id: string, hash: string): Promise<boolean>;
  /** Caches the PDF only if the row still holds the version `expectedHtmlHash` (and is done). */
  setPdfKeyIf(
    id: string,
    expectedHtmlHash: string,
    pdfKey: string,
    pdfAt: number,
  ): Promise<boolean>;
  /** Janitor: every report with the version it currently points at. */
  storageIndex(): Promise<Map<string, { htmlHash: string | null; pdfKey: string | null }>>;
  /** Backfill: reports with a PDF in the legacy `<id>.pdf` cache, ordered by id, after `afterId`. */
  listLegacyPdfs(limit: number, afterId?: string): Promise<Report[]>;

  addNotes(notes: ReportNote[]): Promise<void>;
  notes(reportId: string): Promise<ReportNote[]>;
  /** Removes the notes of a research step (and later ones): it was cut off and will run again. */
  deleteNotesFromStep(reportId: string, step: number): Promise<void>;
}

/** The tools one research run may call (MCP servers of the template and the connected library). */
export interface ResearchTools {
  defs: OAITool[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
  libraryToolNames: Set<string>;
  libraryName: string | null;
  /** Appended to the research system prompt while the library is connected. */
  systemNote: string;
  /** MCP servers that could not be listed. */
  mcpErrors: { server: string; message: string }[];
}

export interface ResearchToolsOptions {
  useMcp: boolean;
  /** Names of the MCP servers the research may call; [] = every enabled server. */
  mcpServers: string[];
  libraryId: string | null;
  /** Cap for one tool output (characters). */
  maxOutputChars: number;
  libraryMaxCalls: number;
  libraryMaxTotalChars: number;
  /** Calls allowed when the library is answered by a remote engine with a small daily quota (NotebookLM). */
  remoteLibraryMaxCalls: number;
}

/** Port: the reports context reaches MCP and the library only through this. */
export interface ResearchToolsPort {
  /** `null` when there is nothing to call (no MCP tools and no usable library). */
  open(options: ResearchToolsOptions): Promise<ResearchTools | null>;
}

export interface ConversationSnapshot {
  /** Rolling summary of the older messages, if any. */
  summary: string | null;
  messages: StoredMessage[];
}

export interface ConversationReaderPort {
  /** `null` when the conversation does not exist. */
  read(conversationId: string): Promise<ConversationSnapshot | null>;
}
