import { describe, expect, it } from 'vitest';
import { friendlyError } from './friendly-error';

describe('friendlyError', () => {
  it('explains Groq token-per-minute limits', () => {
    const r = friendlyError(
      'Todas as conexões falharam. Último erro (context_length): Request too large for model x (TPM): Limit 8000',
    );
    expect(r.title).toMatch(/grande demais/);
    expect(r.detail).toContain('Request too large');
  });
  it('suggests Derivar when the agent conversation overflows', () => {
    const r = friendlyError('Prompt is too long', { agent: true });
    expect(r.title).toMatch(/agente ficou grande demais/);
    expect(r.hint).toMatch(/Derivar/);
    const viaRouter = friendlyError('Último erro (context_length): Request too large', {
      agent: true,
    });
    expect(viaRouter.hint).toMatch(/Derivar/);
  });
  it('keeps the generic overflow message outside agent mode', () => {
    const r = friendlyError('Prompt is too long');
    expect(r.title).toBe('A conversa ficou grande demais para este modelo');
    expect(r.hint).not.toMatch(/Derivar/);
  });
  it('explains an unavailable model', () => {
    expect(friendlyError("Function 'abc': Not found for account 'x'").title).toMatch(/modelo/i);
  });
  it('explains NotebookLM problems', () => {
    expect(friendlyError('NotebookLM não configurado').title).toMatch(/ainda não está configurado/);
    const expired = friendlyError(
      'Credenciais do NotebookLM expiradas ou inválidas. Entre novamente com o Google.',
    );
    expect(expired.title).toMatch(/credenciais do NotebookLM expiraram/);
    expect(expired.hint).toMatch(/Biblioteca/);
    expect(friendlyError('NotebookLM indisponível: connection reset').title).toMatch(
      /não respondeu/,
    );
    expect(friendlyError('Limite de uso do NotebookLM atingido. Tente novamente.').title).toMatch(
      /não respondeu/,
    );
  });
  it('explains oversized uploads (413)', () => {
    const r = friendlyError('Arquivo maior que 20 MB');
    expect(r.title).toBe('O arquivo é grande demais');
    expect(r.hint).toMatch(/20 MB/);
    expect(friendlyError('Request Entity Too Large').title).toBe('O arquivo é grande demais');
  });
  it('keeps unknown messages, shortened', () => {
    expect(friendlyError('x'.repeat(300)).title.length).toBeLessThan(150);
  });
});
