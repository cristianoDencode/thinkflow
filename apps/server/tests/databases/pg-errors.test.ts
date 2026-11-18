import { describe, expect, it } from 'vitest';
import {
  queryErrorMessage,
  sanitizeErrorForAi,
} from '../../src/contexts/databases/application/pg-errors';

describe('sanitizeErrorForAi', () => {
  it('drops the offending value of cast errors', () => {
    const text = sanitizeErrorForAi('invalid input syntax for type integer: "JOAO DA SILVA"');
    expect(text).toBe('invalid input syntax for type integer: "…"');
  });

  it('strips single-quoted literals', () => {
    expect(sanitizeErrorForAi("invalid input value for enum sit: 'Maria'")).toBe(
      "invalid input value for enum sit: '…'",
    );
    expect(sanitizeErrorForAi('syntax error at or near "\'João\'" (posição 30)')).toBe(
      'syntax error at or near "…" (posição 30)',
    );
  });

  it('keeps quoted identifiers the AI needs to fix its SQL', () => {
    expect(sanitizeErrorForAi('column "z01_nome" does not exist')).toBe(
      'column "z01_nome" does not exist',
    );
    expect(sanitizeErrorForAi('relation "public.cgm" does not exist')).toBe(
      'relation "public.cgm" does not exist',
    );
    expect(sanitizeErrorForAi('a coluna "nome" não existe; função "lower" não existe')).toBe(
      'a coluna "nome" não existe; função "lower" não existe',
    );
    expect(
      sanitizeErrorForAi('column "x" does not exist Dica: Perhaps you meant "cgm.z01_nome".'),
    ).toContain('"…"'); // a bare quoted hint could be a value: dropped
  });

  it('keeps the identifiers of the hint for name errors (42703, 42P01, 42702) only', () => {
    const message = 'column "x" does not exist Dica: Perhaps you meant "cgm.z01_nome".';
    for (const code of ['42703', '42P01', '42702'])
      expect(sanitizeErrorForAi(message, code)).toBe(message);
    // other codes keep masking bare quoted text
    expect(sanitizeErrorForAi(message, '22P02')).toContain('"…"');
    // a hint that is not identifier-shaped is still masked
    expect(
      sanitizeErrorForAi('column "x" does not exist Dica: talvez "JOAO DA SILVA".', '42703'),
    ).toContain('"…"');
    // and only the hint is opened up: a quoted value elsewhere is masked as before
    expect(sanitizeErrorForAi('operator foo "Maria" Dica: Perhaps "a.b".', '42703')).toBe(
      'operator foo "…" Dica: Perhaps "a.b".',
    );
  });

  it('drops DETAIL parts and Key (col)=(value) fragments', () => {
    const text = sanitizeErrorForAi(
      'duplicate key value violates unique constraint "cgm_cpf_key"\nDETAIL: Key (cpf)=(52998224725) already exists.',
    );
    expect(text).toBe('duplicate key value violates unique constraint "cgm_cpf_key"');
    expect(sanitizeErrorForAi('Key (cpf)=(52998224725) already exists.')).not.toContain('5299');
    expect(sanitizeErrorForAi('Failing row contains (1, Maria, 52998224725).')).not.toContain(
      'Maria',
    );
    expect(sanitizeErrorForAi('DETALHE: A chave (cpf)=(52998224725) já existe.')).toBe('');
  });

  it('leaves value-free messages alone', () => {
    for (const m of [
      'division by zero',
      'A consulta passou do tempo limite de 30 s e foi cancelada.',
      'operator does not exist: integer = text (posição 40)',
    ])
      expect(sanitizeErrorForAi(m)).toBe(m);
  });
});

describe('queryErrorMessage (analyst-facing) keeps the full text', () => {
  it('does not sanitize', () => {
    const msg = queryErrorMessage(new Error('invalid input syntax for type integer: "JOAO"'), 30);
    expect(msg).toContain('JOAO');
  });
});
