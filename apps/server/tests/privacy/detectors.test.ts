import { describe, expect, it } from 'vitest';
import {
  cardDetector,
  cepDetector,
  cnhDetector,
  cnpjDetector,
  cnsDetector,
  cpfDetector,
  emailDetector,
  isValidCnpj,
  isValidCpf,
  luhn,
  phoneDetector,
  pisDetector,
  plateDetector,
  renavamDetector,
  rgDetector,
  tituloDetector,
} from '../../src/contexts/privacy/domain/detectors';
import type { Detector } from '../../src/contexts/privacy/domain/pii';

/** Texts matched by the detector. */
const matches = (d: Detector, text: string): string[] =>
  d.find(text).map((s) => text.slice(s.start, s.end));

describe('CPF', () => {
  it('detects formatted and bare valid CPFs', () => {
    expect(matches(cpfDetector, 'CPF 529.982.247-25 ok')).toEqual(['529.982.247-25']);
    expect(matches(cpfDetector, 'doc 52998224725.')).toEqual(['52998224725']);
  });
  it('rejects invalid check digits and repeated digits', () => {
    expect(matches(cpfDetector, '529.982.247-26')).toEqual([]);
    expect(matches(cpfDetector, '111.111.111-11')).toEqual([]);
    expect(isValidCpf('000.000.000-00')).toBe(false);
  });
  it('ignores digits glued to other digits', () => {
    expect(matches(cpfDetector, '5299822472512')).toEqual([]);
    expect(matches(cpfDetector, '9529982247251')).toEqual([]);
    expect(matches(cpfDetector, '529.982.247-25.1')).toEqual([]);
  });
  it('scores formatted/context higher than bare', () => {
    const bare = cpfDetector.find('52998224725')[0]!.score;
    const formatted = cpfDetector.find('529.982.247-25')[0]!.score;
    const ctx = cpfDetector.find('CPF: 52998224725')[0]!.score;
    expect(formatted).toBeGreaterThan(bare);
    expect(ctx).toBeGreaterThan(formatted);
  });
});

describe('CNPJ', () => {
  it('detects numeric CNPJ formatted and bare', () => {
    expect(matches(cnpjDetector, 'empresa 11.222.333/0001-81.')).toEqual(['11.222.333/0001-81']);
    expect(matches(cnpjDetector, '11222333000181')).toEqual(['11222333000181']);
  });
  it('validates the alphanumeric (2026) CNPJ by ASCII-48 weights', () => {
    // official example from the Receita Federal documentation
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12ABC34501DE35')).toBe(true);
    expect(isValidCnpj('12.ABC.345/01DE-34')).toBe(false);
    expect(matches(cnpjDetector, 'CNPJ 12.ABC.345/01DE-35')).toEqual(['12.ABC.345/01DE-35']);
  });
  it('requires formatting or context for bare alphanumeric values', () => {
    expect(matches(cnpjDetector, 'id 12ABC34501DE35')).toEqual([]);
    expect(matches(cnpjDetector, 'cnpj 12ABC34501DE35')).toEqual(['12ABC34501DE35']);
  });
  it('rejects invalid DV, repeated chars and glued digits', () => {
    expect(matches(cnpjDetector, '11.222.333/0001-82')).toEqual([]);
    expect(matches(cnpjDetector, '00000000000000')).toEqual([]);
    expect(matches(cnpjDetector, '1122233300018199')).toEqual([]);
  });
});

describe('CNS', () => {
  it('detects definitive (1/2) and provisional (7/8/9) cards', () => {
    expect(matches(cnsDetector, 'cns 980016287385192')).toEqual(['980016287385192']);
    expect(matches(cnsDetector, '898 0011 6066 0001')).toEqual(['898 0011 6066 0001']);
  });
  it('rejects invalid ones and ones starting with other digits', () => {
    expect(matches(cnsDetector, '980016287385193')).toEqual([]);
    expect(matches(cnsDetector, '380016287385192')).toEqual([]);
  });
  it('accepts definitive CNS numbers derived from a PIS (both 000 and 001 forms)', () => {
    expect(matches(cnsDetector, 'cartão sus 123456789000005')).toEqual(['123456789000005']);
    expect(matches(cnsDetector, 'cartão sus 100000000060018')).toEqual(['100000000060018']);
    expect(matches(cnsDetector, 'cartão sus 123456789000006')).toEqual([]);
  });
});

describe('PIS/PASEP/NIS/NIT', () => {
  it('detects formatted PIS without context', () => {
    expect(matches(pisDetector, '123.45678.90-0')).toEqual(['123.45678.90-0']);
  });
  it('demands context for bare numbers', () => {
    expect(matches(pisDetector, 'protocolo 12345678900')).toEqual([]);
    expect(matches(pisDetector, 'PIS 12345678900')).toEqual(['12345678900']);
    expect(matches(pisDetector, 'NIS: 12345678900')).toEqual(['12345678900']);
  });
  it('rejects invalid DV and repeated digits', () => {
    expect(matches(pisDetector, 'PIS 12345678901')).toEqual([]);
    expect(matches(pisDetector, 'PIS 11111111111')).toEqual([]);
  });
});

describe('título de eleitor', () => {
  it('detects with context or spaced groups', () => {
    expect(matches(tituloDetector, 'título de eleitor 123456780191')).toEqual(['123456780191']);
    expect(matches(tituloDetector, '1234 5678 0191')).toEqual(['1234 5678 0191']);
  });
  it('ignores bare 12-digit runs, bad DV and unknown UF', () => {
    expect(matches(tituloDetector, 'codigo 123456780191')).toEqual([]);
    expect(matches(tituloDetector, 'título 123456780192')).toEqual([]);
    expect(matches(tituloDetector, 'título 123456789911')).toEqual([]);
  });
});

describe('CNH', () => {
  it('needs the context word', () => {
    expect(matches(cnhDetector, 'CNH 02650306461')).toEqual(['02650306461']);
    expect(matches(cnhDetector, 'carteira de habilitação: 02650306461')).toEqual(['02650306461']);
    expect(matches(cnhDetector, 'numero 02650306461')).toEqual([]);
  });
  it('rejects invalid DV', () => {
    expect(matches(cnhDetector, 'CNH 02650306462')).toEqual([]);
    expect(matches(cnhDetector, 'CNH 11111111111')).toEqual([]);
  });
});

describe('RENAVAM', () => {
  it('needs the context word and a valid DV', () => {
    expect(matches(renavamDetector, 'renavam 63788358403')).toEqual(['63788358403']);
    expect(matches(renavamDetector, 'renavam 639884962')).toEqual(['639884962']);
    expect(matches(renavamDetector, 'renavam 63788358404')).toEqual([]);
    expect(matches(renavamDetector, 'codigo 63788358403')).toEqual([]);
  });
});

describe('payment card', () => {
  it('detects Luhn-valid formatted and bare cards', () => {
    expect(matches(cardDetector, 'cartão 4111 1111 1111 1111')).toEqual(['4111 1111 1111 1111']);
    expect(matches(cardDetector, '5555-5555-5555-4444')).toEqual(['5555-5555-5555-4444']);
    expect(matches(cardDetector, '5555555555554444')).toEqual(['5555555555554444']);
    expect(matches(cardDetector, '3782 822463 10005')).toEqual(['3782 822463 10005']); // Amex
  });
  it('rejects Luhn failures, short runs and glued digits', () => {
    expect(luhn('4111111111111112')).toBe(false);
    expect(matches(cardDetector, '4111 1111 1111 1112')).toEqual([]);
    expect(matches(cardDetector, '411111111111')).toEqual([]);
    expect(matches(cardDetector, '411111111111111199999999')).toEqual([]);
  });
});

describe('e-mail', () => {
  it('detects addresses and drops trailing punctuation', () => {
    expect(matches(emailDetector, 'fale com Maria.Silva+x@prefeitura.gov.br.')).toEqual([
      'Maria.Silva+x@prefeitura.gov.br',
    ]);
    expect(matches(emailDetector, '<a@b.co>, c_d@e-f.com')).toEqual(['a@b.co', 'c_d@e-f.com']);
  });
  it('ignores non-addresses', () => {
    expect(matches(emailDetector, '@usuario e a@b e x @ y.com')).toEqual([]);
  });
});

describe('telefone', () => {
  it.each([
    '(11) 99999-8888',
    '(11)999998888',
    '+55 (11) 99999-8888',
    '+55 11 99999-8888',
    '+5511999998888',
    '11 99999-8888',
    '(21) 3333-4444',
  ])('detects %s without context', (phone) => {
    expect(matches(phoneDetector, `ligar ${phone} agora`)).toEqual([phone]);
  });
  it('requires context for bare numbers', () => {
    expect(matches(phoneDetector, 'protocolo 11999998888')).toEqual([]);
    expect(matches(phoneDetector, 'celular 11999998888')).toEqual(['11999998888']);
    expect(matches(phoneDetector, 'fone 3333-4444')).toEqual(['3333-4444']);
    expect(matches(phoneDetector, 'codigo 3333-4444')).toEqual([]);
  });
  it('rejects invalid area codes and glued digits', () => {
    expect(matches(phoneDetector, '(10) 99999-8888')).toEqual([]);
    expect(matches(phoneDetector, 'tel 1199999888899')).toEqual([]);
  });
});

describe('CEP e RG (context only)', () => {
  it('CEP needs the word', () => {
    expect(matches(cepDetector, 'CEP: 01310-100')).toEqual(['01310-100']);
    expect(matches(cepDetector, 'cep 01310100')).toEqual(['01310100']);
    expect(matches(cepDetector, 'número 01310-100')).toEqual([]);
    expect(matches(cepDetector, 'CEP 013101000')).toEqual([]);
  });
  it('RG needs the word', () => {
    expect(matches(rgDetector, 'RG 12.345.678-9')).toEqual(['12.345.678-9']);
    expect(matches(rgDetector, 'RG: 12.345.678-X')).toEqual(['12.345.678-X']);
    expect(matches(rgDetector, 'identidade nº 1234567')).toEqual(['1234567']);
    expect(matches(rgDetector, 'valor 12.345.678-9')).toEqual([]);
  });
  it('context word must be a whole word', () => {
    expect(matches(rgDetector, 'cidade 12345678')).toEqual([]);
    expect(matches(cepDetector, 'especial 01310100')).toEqual([]);
  });
});

describe('placa', () => {
  it('detects old and Mercosul plates', () => {
    expect(matches(plateDetector, 'placa ABC-1234')).toEqual(['ABC-1234']);
    expect(matches(plateDetector, 'veículo ABC1D23 parado')).toEqual(['ABC1D23']);
    expect(matches(plateDetector, 'ABC1234')).toEqual(['ABC1234']);
  });
  it('ignores glued letters/digits', () => {
    expect(matches(plateDetector, 'XABC1D23')).toEqual([]);
    expect(matches(plateDetector, 'ABC1D234')).toEqual([]);
    expect(matches(plateDetector, 'abc-1234')).toEqual([]);
  });
});
