import type { PgConnectionParams } from '../domain/ports';

interface ErrorLike {
  message?: string;
  code?: string;
}

function parts(err: unknown): { message: string; code: string } {
  const e = (err ?? {}) as ErrorLike;
  return {
    message: typeof e.message === 'string' ? e.message : String(err),
    code: typeof e.code === 'string' ? e.code : '',
  };
}

/** pt-BR explanation of a failed connection attempt. */
export function friendlyConnectError(
  err: unknown,
  conn: Pick<PgConnectionParams, 'host' | 'port' | 'database' | 'user'>,
): string {
  const { message, code } = parts(err);
  const lower = message.toLowerCase();
  if (code === 'ECONNREFUSED')
    return `Conexão recusada em ${conn.host}:${conn.port}. Verifique se o servidor está no ar e se a porta está correta.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return `Servidor "${conn.host}" não encontrado. Verifique o endereço (host).`;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || lower.includes('timeout'))
    return `Tempo esgotado ao conectar em ${conn.host}:${conn.port}. Verifique host, porta, VPN e firewall.`;
  if (code === '28P01') return `Usuário ou senha incorretos para "${conn.user}".`;
  if (code === '28000' || lower.includes('pg_hba.conf'))
    return 'O servidor recusou o acesso (pg_hba.conf): verifique usuário, banco, endereço de origem e SSL.';
  if (code === '3D000') return `O banco "${conn.database}" não existe nesse servidor.`;
  if (code === '57P03')
    return 'O servidor está iniciando ou em recuperação; tente novamente em instantes.';
  if (
    lower.includes('ssl') ||
    lower.includes('self-signed') ||
    lower.includes('certificate') ||
    code.startsWith('ERR_TLS') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  )
    return `Falha de SSL: ${message}. Ajuste o modo SSL da conexão (desativado, exigir ou verificar certificado).`;
  return `Falha ao conectar: ${message || code || 'erro desconhecido'}`;
}

/** pt-BR message for a failed query (keeps the Postgres text so the SQL can be fixed). */
export function queryErrorMessage(err: unknown, statementTimeoutSec: number): string {
  const { message, code } = parts(err);
  if (code === '57014') {
    return message.toLowerCase().includes('statement timeout')
      ? `A consulta passou do tempo limite de ${statementTimeoutSec} s e foi cancelada. Reduza o período, filtre mais ou agregue.`
      : 'A consulta foi cancelada.';
  }
  if (code === '25006' || message.includes('read-only transaction'))
    return 'O banco recusou a instrução: a conexão é somente leitura.';
  return message || 'Erro ao executar a consulta.';
}

/** Words (en/pt) that announce a quoted SQL identifier, which the AI needs to fix its query. */
const IDENTIFIER_BEFORE_QUOTE =
  /(?:column|relation|table|schema|function|type|alias|role|index|constraint|sequence|view|operator|extension|database|language|collation|trigger|parameter|attribute|domain|coluna|relação|tabela|função|tipo|índice|visão|sequência)\s+$/i;

/** Name errors whose Postgres hint ("Perhaps you meant …") only ever quotes identifiers. */
const IDENTIFIER_HINT_CODES = new Set(['42703', '42P01', '42702']);
const HINT_START = /\b(?:Dica|HINT|Hint)\s*:/;
const IDENTIFIER_SHAPED = /^[\p{L}\p{N}_$.]+$/u;

/**
 * Error text that is safe to hand to the AI. Postgres echoes the offending VALUE in many messages
 * (`invalid input syntax for type integer: "JOAO DA SILVA"`, `Key (cpf)=(1234...) already exists`,
 * `DETAIL:` lines), which would leak personal data even on a structure-only connection. Quoted
 * literals are replaced by `…`, except double-quoted identifiers after words like `column`/`relation`
 * (the AI needs them to correct the SQL); `DETAIL`/`Detalhe` parts and `Key (col)=(value)` fragments
 * are dropped. For the name errors 42703/42P01/42702 (`code`) the identifiers quoted in the hint
 * (`Perhaps you meant "cgm.z01_nome"`) are kept too: they are names, not values. The analyst-facing
 * message keeps the full text: only call this on AI-bound text.
 */
export function sanitizeErrorForAi(message: string, code?: string): string {
  let text = message.replace(/\r/g, '');
  // DETAIL: ... runs to the end of its line; the hint after "Dica:" is kept (identifiers only)
  text = text.replace(/\n?\s*(?:DETAIL|DETALHE|Detail|Detalhe)\s*:[^\n]*/g, '');
  text = text.replace(/\bKey\s*\([^)]*\)\s*=\s*\([^)]*\)/gi, 'Key (…)=(…)');
  text = text.replace(/\bChave\s*\([^)]*\)\s*=\s*\([^)]*\)/gi, 'Chave (…)=(…)');
  text = text.replace(/\bFailing row contains \([^\n]*\)/gi, 'Failing row contains (…)');
  text = text.replace(
    /\b(?:Linha|Registro) com falha contém \([^\n]*\)/gi,
    'Linha com falha contém (…)',
  );
  text = text.replace(/'(?:[^']|'')*'/g, "'…'");
  const hintAt = code && IDENTIFIER_HINT_CODES.has(code) ? text.search(HINT_START) : -1;
  text = text.replace(/"((?:[^"]|"")*)"/g, (full, inner: string, offset: number) => {
    if (IDENTIFIER_BEFORE_QUOTE.test(text.slice(0, offset))) return full;
    return hintAt >= 0 && offset > hintAt && IDENTIFIER_SHAPED.test(inner) ? full : '"…"';
  });
  return text.replace(/[ \t]+\n/g, '\n').trim();
}
