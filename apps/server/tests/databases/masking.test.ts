import { describe, expect, it } from 'vitest';
import {
  isSensitiveColumn,
  looksSensitiveValue,
  maskValue,
  scrubText,
  type MaskingConfig,
} from '../../src/contexts/databases/domain/masking';

const none: MaskingConfig = { sensitiveColumns: [], revealColumns: [] };

describe('isSensitiveColumn', () => {
  it.each([
    'z01_cgccpf',
    'z01_nome',
    'z01_email',
    'z01_telef',
    'z01_ender',
    'z01_cep',
    'z01_nasc',
    'z01_mae',
    'cpf',
    'CNPJ',
    'cpf_cnpj',
    'razao_social',
    'nome_fantasia',
    'telefone_celular',
    'data_nascimento',
    'Endereço',
    'senha_hash',
    'api_token',
    'password',
    'user_email',
    'logradouro',
    'bairro',
    'titulo_eleitor',
    'agencia',
    'iban',
  ])('detects %s', (name) => {
    expect(isSensitiveColumn(name, none)).toBe(true);
  });

  it.each(['id', 'valor', 'exercicio', 'vencimento', 'updated_at', 'created', 'set_id', 'status'])(
    'does not flag %s',
    (name) => {
      expect(isSensitiveColumn(name, none)).toBe(false);
    },
  );

  it('does not flag accounting accounts', () => {
    expect(isSensitiveColumn('conta_contabil', none)).toBe(false);
    expect(isSensitiveColumn('conta_bancaria', none)).toBe(true);
  });

  it('lets the connection add and reveal columns', () => {
    expect(isSensitiveColumn('observacao', none)).toBe(false);
    expect(
      isSensitiveColumn('Observação', { sensitiveColumns: ['observacao'], revealColumns: [] }),
    ).toBe(true);
    expect(
      isSensitiveColumn('z01_nome', { sensitiveColumns: [], revealColumns: ['Z01_NOME'] }),
    ).toBe(false);
    // reveal wins over a custom sensitive entry too
    expect(isSensitiveColumn('cpf', { sensitiveColumns: ['cpf'], revealColumns: ['cpf'] })).toBe(
      false,
    );
  });
});

describe('maskValue', () => {
  it('keeps the first and last two digits of documents', () => {
    expect(maskValue('10123456760', 'digits')).toBe('10*******60');
    expect(maskValue('101.234.567-60', 'digits')).toBe('10*******60');
    expect(maskValue('10123456760')).toBe('10*******60'); // inferred from the value
    expect(maskValue('12345678000199', 'digits')).toBe('12**********99');
    expect(maskValue('123', 'digits')).toBe('***');
  });

  it('masks e-mails', () => {
    expect(maskValue('ana.souza@dominio.com.br')).toBe('a***@d***.com.br');
    expect(maskValue('ana@x.org', 'email')).toBe('a***@x***.org');
  });

  it('masks names word by word', () => {
    expect(maskValue('Maria da Silva', 'name')).toBe('M*** d* S***');
  });

  it('hides secrets entirely', () => {
    expect(maskValue('s3nh4-super', 'secret')).toBe('••••');
  });

  it('masks generic text and numbers, and keeps null', () => {
    expect(maskValue('Rua das Flores, 100', 'generic')).toBe('Ru********00');
    expect(maskValue('abc', 'generic')).toBe('***');
    expect(maskValue(1234567, 'generic')).toBe('12***67');
    expect(maskValue(null, 'name')).toBeNull();
    expect(maskValue(undefined)).toBeNull();
  });
});

describe('looksSensitiveValue', () => {
  it.each([
    '10123456760',
    '101.234.567-60',
    '12.345.678/0001-99',
    '12345678000199',
    'a@b.com',
    '(11) 98765-4321',
  ])('detects %s', (v) => {
    expect(looksSensitiveValue(v)).toBe(true);
  });

  it.each(['Maria', '150.00', '2024-01-10', '12345', null, 42, ''])('ignores %s', (v) => {
    expect(looksSensitiveValue(v)).toBe(false);
  });
});

describe('scrubText', () => {
  it('masks formatted documents and e-mails embedded in text', () => {
    const out = scrubText('Contato ana@dominio.com, CPF 101.234.567-60, CNPJ 12.345.678/0001-99.');
    expect(out).not.toContain('101.234.567-60');
    expect(out).not.toContain('ana@dominio.com');
    expect(out).not.toContain('12.345.678/0001-99');
    expect(out).toContain('10*******60');
  });
});

describe('masking reuses the privacy detectors', () => {
  it('flags bare/validated documents the format regexes miss', () => {
    expect(looksSensitiveValue('12.ABC.345/01DE-35')).toBe(true); // alphanumeric CNPJ
    expect(looksSensitiveValue('4111 1111 1111 1111')).toBe(true); // card
    expect(looksSensitiveValue('ABC1D23')).toBe(true); // Mercosul plate
  });

  it('scrubText also masks bare CPFs, phones and person names', () => {
    const out = scrubText('JOAO DA SILVA, CPF 52998224725, fone (11) 99999-8888.');
    expect(out).not.toContain('52998224725');
    expect(out).not.toContain('99999-8888');
    expect(out).not.toContain('JOAO');
    expect(out).toContain('52*******25');
  });
});
