import { describe, expect, it } from 'vitest';
import {
  buildFileName,
  sanitizeFileName,
  withCounter,
} from '../../src/contexts/onedrive/domain/file-name';

describe('sanitizeFileName', () => {
  it('replaces characters OneDrive rejects', () => {
    expect(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j.docx')).toBe('a-b-c-d-e-f-g-h-i-j.docx');
  });

  it('removes control characters, collapses spaces and trims trailing dots', () => {
    expect(sanitizeFileName('  um\u0000   dois .  ')).toBe('um dois');
  });

  it('caps the length but keeps the extension', () => {
    const name = sanitizeFileName(`${'x'.repeat(400)}.docx`);
    expect(name.length).toBeLessThanOrEqual(150);
    expect(name.endsWith('.docx')).toBe(true);
  });

  it('avoids reserved device names and falls back for empty input', () => {
    expect(sanitizeFileName('CON.docx')).toBe('_CON.docx');
    expect(sanitizeFileName('???')).toBe('-');
    expect(sanitizeFileName('')).toBe('documento');
  });
});

describe('buildFileName', () => {
  it('applies the default pattern', () => {
    expect(buildFileName(undefined, { ticketId: '893.687', title: 'Login com erro' })).toBe(
      'CT 893.687 - Login com erro.docx',
    );
  });

  it('sanitizes the title and keeps the pattern text', () => {
    expect(buildFileName('CT {ticketId} - {title}.docx', { ticketId: '1', title: 'a/b: c?' })).toBe(
      'CT 1 - a-b- c-.docx',
    );
  });

  it('adds .docx when the pattern forgot it and drops a dangling separator', () => {
    expect(buildFileName('CT {ticketId} - {title}', { ticketId: '7', title: '' })).toBe(
      'CT 7.docx',
    );
    expect(buildFileName('CT {ticketId} - {title}.docx', { ticketId: '7', title: '' })).toBe(
      'CT 7.docx',
    );
  });
});

describe('withCounter', () => {
  it('keeps the first name and numbers the next ones before the extension', () => {
    expect(withCounter('CT 1.docx', 1)).toBe('CT 1.docx');
    expect(withCounter('CT 1.docx', 2)).toBe('CT 1 (2).docx');
    expect(withCounter('CT 1.docx', 10)).toBe('CT 1 (10).docx');
    expect(withCounter('semext', 3)).toBe('semext (3)');
  });
});
