import {
  extractSqlBlocks,
  type SqlBlockValidationDto,
  type SqlValidationDto,
} from '@thinkflow/shared';
import type { DataChatTools } from '../domain/conversation';

/** More blocks than this in one answer are listed but not checked (each one costs a round trip). */
export const MAX_CHECKED_SQL_BLOCKS = 6;

export interface AnswerSqlCheck {
  blocks: SqlBlockValidationDto[];
  /** Message that asks the model to rewrite its answer; null when no block names a missing table/column. */
  correction: string | null;
}

const skipped = (): SqlValidationDto => ({
  status: 'unchecked',
  issues: [],
  reason: `Só os ${MAX_CHECKED_SQL_BLOCKS} primeiros blocos SQL da resposta são conferidos.`,
});

function correctionMessage(findings: { index: number; aiText: string }[]): string {
  return [
    'Conferi o SQL que você escreveu na resposta (nada foi executado) e há tabelas ou colunas que não existem no banco:',
    ...findings.map((f) => `Bloco SQL ${f.index + 1}:\n${f.aiText}`),
    'Reescreva a resposta inteira com o SQL corrigido. Use apenas tabelas e colunas confirmadas pelas ferramentas (use descrever_tabela se precisar) e não repita os nomes inexistentes. Não mencione esta verificação.',
  ].join('\n\n');
}

/**
 * Checks every SQL block of a data-mode answer against the database without running anything.
 * Never throws except when `signal` aborts (the checks themselves fail soft into `unchecked`).
 */
export async function checkAnswerSql(
  data: Pick<DataChatTools, 'validateSql'>,
  text: string,
  signal?: AbortSignal,
): Promise<AnswerSqlCheck> {
  const validate = data.validateSql;
  const found = extractSqlBlocks(text);
  if (!validate || found.length === 0) return { blocks: [], correction: null };

  const blocks: SqlBlockValidationDto[] = [];
  const findings: { index: number; aiText: string }[] = [];
  for (const block of found) {
    if (block.index >= MAX_CHECKED_SQL_BLOCKS) {
      blocks.push({ index: block.index, ...skipped() });
      continue;
    }
    try {
      const { validation, aiText } = await validate.call(data, block.sql, signal);
      blocks.push({ index: block.index, ...validation });
      if (validation.status === 'invalid' && aiText) findings.push({ index: block.index, aiText });
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error('aborted');
      blocks.push({
        index: block.index,
        status: 'unchecked',
        issues: [],
        reason: 'Não foi possível conferir este SQL.',
      });
    }
  }
  return { blocks, correction: findings.length > 0 ? correctionMessage(findings) : null };
}
