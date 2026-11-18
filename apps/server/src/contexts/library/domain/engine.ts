import type { LibrarySearchHitDto } from '@thinkflow/shared';
import type { Library, LibraryDocument, LibraryEngineKind } from './library';

export interface LibraryToolResult {
  text: string;
  isError: boolean;
  citations: { documentId: string; documentName: string; page?: number | null }[];
  /** Structured hits (local engine); remote engines may omit them. */
  hits?: LibrarySearchHitDto[];
}

/** Strategy behind a library: how documents are searched (and, for remote engines, synced). */
export interface LibraryEngine {
  readonly kind: LibraryEngineKind;
  search(
    library: Library,
    question: string,
    opts: { k: number; maxChars: number; signal?: AbortSignal },
  ): Promise<LibraryToolResult>;
  /** Remote engines: called once the document is indexed locally. */
  onDocumentIndexed?(library: Library, doc: LibraryDocument): Promise<void>;
  onDocumentDeleted?(library: Library, doc: LibraryDocument): Promise<void>;
  /** Remote engines: creates the remote notebook; the result is merged into the library. */
  onLibraryCreated?(library: Library): Promise<Partial<Library>>;
  onLibraryDeleted?(library: Library): Promise<void>;
}
