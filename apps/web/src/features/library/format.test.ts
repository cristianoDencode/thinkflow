import { describe, expect, it } from 'vitest';
import { checkFile, chunk, formatBytes, isWaitingOcr, splitFiles, statusView } from './format';

const file = (name: string, size = 100) => ({ name, size }) as File;

describe('formatBytes', () => {
  it('formats units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });
});

describe('statusView', () => {
  it('maps statuses and special-cases the OCR placeholder', () => {
    expect(statusView({ status: 'ready', error: null }).label).toBe('Pronto');
    expect(statusView({ status: 'processing', error: null }).spinner).toBe(true);
    const ocr = { status: 'error', error: 'Aguardando OCR: ainda não disponível' } as const;
    expect(isWaitingOcr(ocr)).toBe(true);
    expect(statusView(ocr).tone).toBe('warning');
    const off = { status: 'error', error: 'OCR desativado em Biblioteca → Configurações' } as const;
    expect(isWaitingOcr(off)).toBe(true);
    expect(statusView(off)).toMatchObject({ label: 'OCR desativado', tone: 'warning' });
    expect(statusView({ status: 'error', error: 'PDF corrompido' }).tone).toBe('danger');
  });
});

describe('checkFile / splitFiles', () => {
  it('rejects unsupported types and oversized files', () => {
    expect(checkFile(file('a.pdf')).ok).toBe(true);
    expect(checkFile(file('a.exe'))).toEqual({
      ok: false,
      reason: 'Tipo de arquivo não suportado',
    });
    expect(checkFile(file('a.pdf', 21 * 1024 * 1024))).toEqual({
      ok: false,
      reason: 'Arquivo maior que 20 MB',
    });
    expect(checkFile(file('a.png', 11 * 1024 * 1024)).ok).toBe(false);
  });

  it('respects free slots', () => {
    const { accepted, rejected } = splitFiles(
      [file('a.txt'), file('b.txt'), file('c.txt')],
      2,
      1000,
    );
    expect(accepted.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
    expect(rejected).toEqual([
      { name: 'c.txt', reason: 'Limite de 1000 documentos por biblioteca' },
    ]);
  });

  it('uses the library limit in the rejection reason', () => {
    const { rejected } = splitFiles([file('a.txt'), file('b.txt')], 1, 300);
    expect(rejected[0]?.reason).toBe('Limite de 300 documentos por biblioteca');
  });

  it('accepts more than 50 files when the library allows it', () => {
    const many = Array.from({ length: 120 }, (_, i) => file(`f${i}.txt`));
    expect(splitFiles(many, 1000, 1000).accepted).toHaveLength(120);
  });
});

describe('chunk', () => {
  it('batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
