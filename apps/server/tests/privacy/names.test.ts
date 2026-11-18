import { describe, expect, it } from 'vitest';
import { isFirstName, nameDetector } from '../../src/contexts/privacy/domain/names';
import prenomes from '../../src/contexts/privacy/data/prenomes.json';

const names = (text: string): string[] =>
  nameDetector.find(text).map((s) => text.slice(s.start, s.end));

describe('prenomes dictionary', () => {
  it('is lowercase, accent-free and large enough', () => {
    const list = prenomes as string[];
    expect(list.length).toBeGreaterThan(1500);
    expect(list.every((n) => /^[a-z]{2,}$/.test(n))).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });
  it('matches ignoring case and accents', () => {
    expect(isFirstName('João')).toBe(true);
    expect(isFirstName('JOAO')).toBe(true);
    expect(isFirstName('Conceição')).toBe(true);
    expect(isFirstName('Brasil')).toBe(false);
    expect(isFirstName('Rua')).toBe(false);
  });
});

describe('person names', () => {
  it('detects capitalized names with connectors', () => {
    expect(names('Atendido: João da Silva, hoje')).toEqual(['João da Silva']);
    expect(names('Maria de Lourdes Souza Lima compareceu')).toEqual([
      'Maria de Lourdes Souza Lima',
    ]);
    expect(names('Ana Paula e Pedro Henrique')).toEqual(['Ana Paula e Pedro Henrique']);
  });
  it('detects e-Cidade ALL CAPS names', () => {
    expect(names('JOAO DA SILVA')).toEqual(['JOAO DA SILVA']);
    expect(names('contribuinte MARIA APARECIDA DOS SANTOS pagou')).toEqual([
      'MARIA APARECIDA DOS SANTOS',
    ]);
  });
  it('starts at the first known first name', () => {
    expect(names('Ontem Carlos Eduardo Pereira ligou')).toEqual(['Carlos Eduardo Pereira']);
  });
  it('needs at least two capitalized words', () => {
    expect(names('João chegou cedo')).toEqual([]);
    expect(names('Maria')).toEqual([]);
    expect(names('o pedro silva')).toEqual([]); // lowercase
  });
  it('does not flag places and common phrases', () => {
    expect(names('Rua Das Flores, 100')).toEqual([]);
    expect(names('Brasil Telecom e Banco do Brasil')).toEqual([]);
    expect(names('Prefeitura Municipal de São Paulo')).toEqual([]);
    expect(names('Avenida Brasil')).toEqual([]);
  });
  it('does not join words across punctuation or lines', () => {
    expect(names('Maria, Silva')).toEqual([]);
    expect(names('Maria\nSilva')).toEqual([]);
  });
  it('does not end on a dangling connector', () => {
    expect(names('Pedro Alves de volta')).toEqual(['Pedro Alves']);
  });
  it('finds several names in one text', () => {
    expect(names('De: José Santos; Para: Fernanda Lima')).toEqual(['José Santos', 'Fernanda Lima']);
  });
});
