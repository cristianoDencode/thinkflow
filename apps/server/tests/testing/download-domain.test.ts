import { describe, expect, it } from 'vitest';
import {
  attachmentDisposition,
  contentTypeFor,
  linkCandidates,
  safeDownloadUrl,
  sanitizeFileName,
  servedContentType,
  sizeLabel,
  storageFileName,
} from '../../src/contexts/testing/domain/download';
import { isValidObjectKey } from '../../src/shared/infrastructure/storage/object-keys';

describe('file names', () => {
  it('sanitizes what the page suggests', () => {
    expect(sanitizeFileName('relatório.xlsx')).toBe('relatório.xlsx');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\x\\boleto.pdf')).toBe('boleto.pdf');
    expect(sanitizeFileName('a<b>:"c|d?.txt')).toBe('a_b___c_d_.txt');
    expect(sanitizeFileName('  ..oculto.  ')).toBe('oculto');
    expect(sanitizeFileName('')).toBe('download');
    expect(sanitizeFileName('...')).toBe('download');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    const long = sanitizeFileName(`${'a'.repeat(300)}.xlsx`);
    expect(long).toHaveLength(150);
    expect(long.endsWith('.xlsx')).toBe(true);
  });

  it('builds storage names the object store accepts', () => {
    for (const name of [
      'Relatório Março.xlsx',
      'ÁÉÍ 100%.PDF',
      '___.csv',
      '日本語.txt',
      '..a..b',
    ]) {
      const stored = storageFileName(sanitizeFileName(name));
      expect(isValidObjectKey(`s/downloads/i/${stored}`), `${name} -> ${stored}`).toBe(true);
    }
    expect(storageFileName('Relatório Março.xlsx')).toBe('relatorio-marco.xlsx');
  });

  it('puts the real name in a safe Content-Disposition', () => {
    expect(attachmentDisposition('boleto.pdf')).toBe(
      `attachment; filename="boleto.pdf"; filename*=UTF-8''boleto.pdf`,
    );
    const header = attachmentDisposition('a"b\\c Março (1).pdf');
    expect(header).toContain('filename="a_b_c Mar_o (1).pdf"');
    expect(header).toContain("filename*=UTF-8''a%22b%5Cc%20Mar%C3%A7o%20%281%29.pdf");
  });
});

describe('content types', () => {
  it('uses the extension, then sniffs, then falls back to bytes', () => {
    expect(contentTypeFor('x.XLSX')).toContain('spreadsheetml');
    expect(contentTypeFor('x.csv')).toBe('text/csv');
    expect(contentTypeFor('semext', new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(contentTypeFor('semext', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(
      'application/zip',
    );
    expect(contentTypeFor('semext', new Uint8Array([1, 2, 3]))).toBe('application/octet-stream');
    // the extension wins over the bytes
    expect(contentTypeFor('x.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toContain(
      'spreadsheetml',
    );
  });

  it('never serves a type a browser could run', () => {
    expect(servedContentType('text/html')).toBe('application/octet-stream');
    expect(servedContentType('image/svg+xml')).toBe('application/octet-stream');
    expect(servedContentType('application/pdf')).toBe('application/pdf');
  });
});

describe('urls and sizes', () => {
  it('keeps only origin and path', () => {
    expect(safeDownloadUrl('https://a.b/rel/x.xlsx?token=abc#frag')).toBe('https://a.b/rel/x.xlsx');
    expect(safeDownloadUrl('blob:https://a.b/uuid?x=1')).toBe('blob:https://a.b');
    expect(safeDownloadUrl('data:text/csv;base64,AAAA')).toBe('data:');
    expect(safeDownloadUrl('não é url')).toBe('');
  });

  it('formats sizes', () => {
    expect(sizeLabel(10)).toBe('10 B');
    expect(sizeLabel(1536)).toBe('1.5 KB');
    expect(sizeLabel(100 * 1024 * 1024)).toBe('100 MB');
  });
});

describe('linkCandidates', () => {
  const marks = [
    { pageId: 'p1', at: 1_000, step: 'a' },
    { pageId: 'p1', at: 5_000, step: 'b' },
    { pageId: 'p2', at: 6_000, step: 'c' },
    { pageId: null, at: 100, step: 'goto' },
  ];
  const steps = (m: ReturnType<typeof linkCandidates<string>>) => m.map((x) => x.step);

  it('lists the page steps within the window, newest first', () => {
    // the initial goto (no page yet) counts for every page
    expect(steps(linkCandidates(marks, 'p1', 7_000))).toEqual(['b', 'a', 'goto']);
    expect(steps(linkCandidates(marks, 'p1', 12_000))).toEqual(['b']);
    expect(steps(linkCandidates(marks, 'p1', 20_000))).toEqual([]);
  });

  it('does not credit steps recorded well after the download started', () => {
    expect(steps(linkCandidates(marks, 'p1', 4_500))).toEqual(['b', 'a', 'goto']); // clock slack
    expect(steps(linkCandidates(marks, 'p1', 2_500))).toEqual(['a', 'goto']);
  });

  it('falls back to the other pages for a page without steps (popup)', () => {
    expect(steps(linkCandidates(marks, 'popup', 7_000))).toEqual(['c', 'b', 'a', 'goto']);
  });
});
