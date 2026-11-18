import { describe, expect, it } from 'vitest';
import { parseCtDocument } from '../../../src/contexts/testing/application/ct-document-schema';
import {
  CT_LIMITS,
  createCtDocument,
  ctAnalysisTitle,
  ctImageKeys,
  ctLines,
  ctMissingImageKeys,
  ctUseCaseTitle,
  emptyCtUseCase,
  fitImage,
  formatCtDate,
} from '../../../src/contexts/testing/domain/ct-document';
import { sampleDoc } from './ct-fixtures';

describe('CT document model', () => {
  it('createCtDocument fills defaults and the first version row', () => {
    const doc = createCtDocument({ author: 'Fulana' }, new Date('2026-11-12T15:00:00Z'));
    expect(doc).toMatchObject({
      priority: 'Normal',
      analysisTitle: 'Análise',
      useCases: [],
      versions: [
        {
          version: '1.0',
          date: '12/11/2026',
          description: 'Criação do documento',
          author: 'Fulana',
        },
      ],
    });
  });

  it('formats dates as dd/mm/aaaa in the Brasília time zone', () => {
    // 01:30 UTC on the 13th is still the 12th in Brasília
    expect(formatCtDate(new Date('2026-11-13T01:30:00Z'))).toBe('12/11/2026');
  });

  it('names use cases "Caso de Uso N" unless a title is set', () => {
    expect(ctUseCaseTitle(emptyCtUseCase(), 0)).toBe('Caso de Uso 1');
    expect(ctUseCaseTitle({ ...emptyCtUseCase(), title: '  ' }, 2)).toBe('Caso de Uso 3');
    expect(ctUseCaseTitle({ ...emptyCtUseCase(), title: 'Fluxo B' }, 2)).toBe('Fluxo B');
  });

  it('falls back to "Análise" for a blank analysis title', () => {
    expect(ctAnalysisTitle({ analysisTitle: '  ' })).toBe('Análise');
    expect(ctAnalysisTitle({ analysisTitle: 'Descrição da Demanda' })).toBe('Descrição da Demanda');
  });

  it('lists distinct image keys in reading order and finds the missing ones', () => {
    const doc = sampleDoc();
    expect(ctImageKeys(doc)).toEqual(['evid/tela-1.png', 'evid/tela-2.png']);
    expect(ctMissingImageKeys(doc, (k) => k === 'evid/tela-1.png')).toEqual(['evid/tela-2.png']);
  });

  it('splits lines keeping blank ones and normalising CRLF', () => {
    expect(ctLines('a\r\n\r\nb\rc')).toEqual(['a', '', 'b', 'c']);
  });

  it('fits images to the width keeping the aspect ratio, capped by the height', () => {
    expect(fitImage(1534, 602, 628, 866)).toEqual({ width: 628, height: 246 });
    expect(fitImage(100, 50, 628, 866)).toEqual({ width: 628, height: 314 });
    const tall = fitImage(500, 4000, 628, 866);
    expect(tall.height).toBe(866);
    expect(tall.width).toBe(108);
  });
});

describe('CT document schema', () => {
  it('accepts a full document and keeps it unchanged', () => {
    const doc = sampleDoc();
    const res = parseCtDocument(doc);
    expect(res).toEqual({ ok: true, document: doc });
  });

  it('applies defaults to a minimal payload', () => {
    const res = parseCtDocument({ useCases: [{ items: [{ kind: 'text', text: 'x' }] }] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.document).toMatchObject({
        title: '',
        priority: 'Normal',
        analysisTitle: 'Análise',
        versions: [],
      });
      expect(res.document.useCases[0]).toMatchObject({ status: 'Finalizado' });
    }
  });

  it('trims header fields but keeps the whitespace of text and code', () => {
    const res = parseCtDocument({
      title: '  Título  ',
      analysisTitle: '   ',
      useCases: [{ items: [{ kind: 'code', text: '  SELECT 1;\n    FROM x  ' }] }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.document.title).toBe('Título');
      expect(res.document.analysisTitle).toBe('Análise');
      expect(res.document.useCases[0]!.items[0]).toEqual({
        kind: 'code',
        text: '  SELECT 1;\n    FROM x  ',
      });
    }
  });

  it('rejects unknown item kinds, bad image sizes and missing version numbers with pt-BR paths', () => {
    const res = parseCtDocument({
      useCases: [
        {
          items: [
            { kind: 'video', url: 'x' },
            { kind: 'image', key: 'a', width: 0, height: 10 },
            { kind: 'image', key: '', width: 10, height: 10 },
          ],
        },
      ],
      versions: [{ version: '' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const text = res.errors.join('\n');
      expect(text).toContain('useCases.0.items.0');
      expect(text).toContain('useCases.0.items.1.width');
      expect(text).toContain('Imagem sem chave.');
      expect(text).toContain('Versão: informe um valor.');
    }
  });

  it('enforces the size limits', () => {
    const tooMany = Array.from({ length: CT_LIMITS.maxUseCases + 1 }, () => ({ items: [] }));
    expect(parseCtDocument({ useCases: tooMany }).ok).toBe(false);
    expect(parseCtDocument({ context: 'x'.repeat(CT_LIMITS.maxContextChars + 1) }).ok).toBe(false);
    expect(parseCtDocument('nope').ok).toBe(false);
  });
});
