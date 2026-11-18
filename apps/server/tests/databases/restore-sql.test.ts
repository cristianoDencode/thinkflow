import { describe, expect, it } from 'vitest';
import { restoreSql } from '../../src/contexts/databases/domain/restore-sql';
import { InMemoryVault } from '../../src/contexts/privacy/domain/vault';

function vaultWith() {
  const vault = new InMemoryVault();
  return {
    vault,
    cpf: vault.tokenFor('CPF', '529.982.247-25'),
    nome: vault.tokenFor('NOME', "Maria D'Ávila"),
    num: vault.tokenFor('VALOR', '42'),
  };
}

describe('restoreSql', () => {
  it('restores tokens inside string literals, doubling quotes', () => {
    const { vault, cpf, nome } = vaultWith();
    expect(restoreSql(`select 1 where a = '${cpf}' or n = '${nome}'`, vault)).toBe(
      "select 1 where a = '529.982.247-25' or n = 'Maria D''Ávila'",
    );
  });

  it('quotes the value when the AI forgot the quotes, except plain numbers', () => {
    const { vault, cpf, nome, num } = vaultWith();
    expect(restoreSql(`where a = ${cpf} and n = ${nome} and k = ${num}`, vault)).toBe(
      "where a = '529.982.247-25' and n = 'Maria D''Ávila' and k = 42",
    );
  });

  it('cannot be used to break out of a literal', () => {
    const vault = new InMemoryVault();
    const evil = vault.tokenFor('NOME', "x' OR '1'='1");
    expect(restoreSql(`select 1 where n = '${evil}'`, vault)).toBe(
      "select 1 where n = 'x'' OR ''1''=''1'",
    );
  });

  it('leaves unknown tokens and comments alone', () => {
    const { vault, cpf } = vaultWith();
    expect(restoreSql("select '[CPF_99]'", vault)).toBe("select '[CPF_99]'");
    expect(restoreSql(`select 1 -- ${cpf}\n/* ${cpf} */`, vault)).toBe(
      `select 1 -- ${cpf}\n/* ${cpf} */`,
    );
  });

  it('handles escaped quotes and array subscripts without confusion', () => {
    const { vault, cpf } = vaultWith();
    expect(restoreSql(`select a[1], 'it''s ${cpf}'`, vault)).toBe(
      "select a[1], 'it''s 529.982.247-25'",
    );
  });
});
