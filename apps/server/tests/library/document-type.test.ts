import { describe, expect, it } from 'vitest';
import {
  LEGACY_DOC_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
  detectDocumentKind,
  extensionForKind,
  mimeForKind,
  unsupportedTypeReason,
} from '../../src/contexts/library/domain/document-type';
import {
  LIBRARY_LIMITS,
  assertCanAddDocument,
  maxDocumentsFor,
  checkCanAddDocument,
  checkTextWithinLimits,
  sanitizeDisplayName,
} from '../../src/contexts/library/domain/library';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('detectDocumentKind', () => {
  it('trusts magic bytes over the name', () => {
    expect(detectDocumentKind(text('%PDF-1.7 ...'), 'arquivo.bin')).toBe('pdf');
    expect(detectDocumentKind(bytes(0x89, 0x50, 0x4e, 0x47, 1, 2), 'foto.dat')).toBe('image');
    expect(detectDocumentKind(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.jpg')).toBe('image');
    const webp = Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WEBPVP8 ')]);
    expect(detectDocumentKind(webp, 'x.webp')).toBe('image');
  });

  it('accepts a zip only when named .docx', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);
    expect(detectDocumentKind(zip, 'Regras.DOCX')).toBe('docx');
    expect(detectDocumentKind(zip, 'dados.zip')).toBeNull();
  });

  it('detects markdown and text by extension and valid UTF-8', () => {
    expect(detectDocumentKind(text('# Título\n\nação'), 'a.md')).toBe('markdown');
    expect(detectDocumentKind(text('x'), 'a.markdown')).toBe('markdown');
    expect(detectDocumentKind(text('olá'), 'a.txt')).toBe('text');
    expect(detectDocumentKind(text('olá'), 'sem-extensao', 'text/plain; charset=utf-8')).toBe(
      'text',
    );
    expect(detectDocumentKind(bytes(0xff, 0xfe, 0x41, 0x80), 'a.txt')).toBeNull();
    expect(detectDocumentKind(bytes(0x41, 0x00, 0x42), 'a.txt')).toBeNull();
  });

  it('rejects renamed binaries and unknown types', () => {
    expect(detectDocumentKind(bytes(0x4d, 0x5a, 0x90, 0x00), 'virus.pdf.exe')).toBeNull();
    expect(detectDocumentKind(bytes(0x4d, 0x5a, 0x90, 0x00), 'virus.txt')).toBeNull();
    expect(detectDocumentKind(text('x'), 'planilha.csv')).toBeNull();
  });

  it('explains rejections, with a specific message for legacy .doc', () => {
    expect(unsupportedTypeReason('velho.doc')).toBe(LEGACY_DOC_MESSAGE);
    expect(unsupportedTypeReason('a.exe')).toBe(UNSUPPORTED_TYPE_MESSAGE);
  });

  it('derives storage extension and mime from the kind, never from the user name', () => {
    expect(extensionForKind('pdf')).toBe('pdf');
    expect(extensionForKind('markdown')).toBe('md');
    expect(extensionForKind('image', bytes(0xff, 0xd8, 0xff))).toBe('jpg');
    expect(extensionForKind('image', bytes(0x89, 0x50, 0x4e, 0x47))).toBe('png');
    expect(mimeForKind('image', bytes(0x89, 0x50, 0x4e, 0x47))).toBe('image/png');
    expect(mimeForKind('pdf')).toBe('application/pdf');
  });
});

describe('library guards', () => {
  it('limits the number of documents by the given maximum', () => {
    const base = { kind: 'pdf', sizeBytes: 10 } as const;
    expect(checkCanAddDocument({ ...base, existingCount: 49, maxDocuments: 50 })).toBeNull();
    expect(checkCanAddDocument({ ...base, existingCount: 50, maxDocuments: 50 })).toMatch(
      /máximo de 50/,
    );
    expect(
      checkCanAddDocument({ ...base, existingCount: 300, maxDocuments: 300, engine: 'notebooklm' }),
    ).toBe('A conta do NotebookLM permite no máximo 300 fontes por notebook');
  });

  it('accepts the 51st document of a local library (limit 1000)', () => {
    const max = maxDocumentsFor('local');
    expect(max).toBe(1000);
    expect(
      checkCanAddDocument({ existingCount: 50, kind: 'pdf', sizeBytes: 10, maxDocuments: max }),
    ).toBeNull();
    expect(
      checkCanAddDocument({ existingCount: 999, kind: 'pdf', sizeBytes: 10, maxDocuments: max }),
    ).toBeNull();
    expect(
      checkCanAddDocument({ existingCount: 1000, kind: 'pdf', sizeBytes: 10, maxDocuments: max }),
    ).toMatch(/máximo de 1000/);
  });

  it('stops a NotebookLM library at the account source limit', () => {
    const maxDocuments = maxDocumentsFor('notebooklm', 100);
    expect(
      checkCanAddDocument({
        existingCount: 99,
        kind: 'pdf',
        sizeBytes: 10,
        maxDocuments,
        engine: 'notebooklm',
      }),
    ).toBeNull();
    expect(
      checkCanAddDocument({
        existingCount: 100,
        kind: 'pdf',
        sizeBytes: 10,
        maxDocuments,
        engine: 'notebooklm',
      }),
    ).toMatch(/permite no máximo 100 fontes/);
  });

  it('limits size per kind and rejects empty files', () => {
    const over = LIBRARY_LIMITS.maxFileBytes + 1;
    expect(
      checkCanAddDocument({ existingCount: 0, kind: 'pdf', sizeBytes: over, maxDocuments: 50 }),
    ).toBe('Arquivo maior que 20 MB');
    expect(
      checkCanAddDocument({
        existingCount: 0,
        kind: 'image',
        sizeBytes: LIBRARY_LIMITS.maxImageBytes + 1,
        maxDocuments: 50,
      }),
    ).toBe('Arquivo maior que 10 MB');
    expect(
      checkCanAddDocument({
        existingCount: 0,
        kind: 'image',
        sizeBytes: 15 * 1024 * 1024,
        maxDocuments: 50,
      }),
    ).toMatch(/10 MB/);
    expect(
      checkCanAddDocument({ existingCount: 0, kind: 'text', sizeBytes: 0, maxDocuments: 50 }),
    ).toBe('Arquivo vazio');
  });

  it('assertCanAddDocument throws a 400 DomainError', () => {
    expect(() =>
      assertCanAddDocument({ existingCount: 50, kind: 'pdf', sizeBytes: 1, maxDocuments: 50 }),
    ).toThrow(/máximo/);
    expect(() =>
      assertCanAddDocument({ existingCount: 0, kind: 'pdf', sizeBytes: 1, maxDocuments: 50 }),
    ).not.toThrow();
  });

  it('limits extracted characters per document and per library', () => {
    expect(checkTextWithinLimits({ documentChars: 1000, libraryChars: 0 })).toBeNull();
    expect(
      checkTextWithinLimits({
        documentChars: LIBRARY_LIMITS.maxDocumentChars + 1,
        libraryChars: 0,
      }),
    ).toMatch(/1,5 mi/);
    expect(
      checkTextWithinLimits({
        documentChars: 1_000_000,
        libraryChars: LIBRARY_LIMITS.maxLibraryChars - 10,
      }),
    ).toMatch(/60 mi/);
  });

  it('sanitizes display names', () => {
    expect(sanitizeDisplayName('C:\\temp\\..\\Regras <1>.pdf')).toBe('Regras 1.pdf');
    expect(sanitizeDisplayName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDisplayName('  ')).toBe('documento');
    expect(sanitizeDisplayName('a\u0000b\n.md')).toBe('ab.md');
    const long = sanitizeDisplayName(`${'x'.repeat(400)}.pdf`);
    expect(long.length).toBe(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});
