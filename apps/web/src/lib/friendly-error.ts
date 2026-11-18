export interface FriendlyError {
  title: string;
  hint?: string;
  /** Original technical message, shown under "Ver detalhes". */
  detail: string;
}

interface Rule {
  test: RegExp;
  title: string;
  hint?: string;
  /** Only applies to errors coming from the agent (Claude Code) mode. */
  agentOnly?: boolean;
}

export interface FriendlyErrorContext {
  /** True when the error came from an agent turn. */
  agent?: boolean;
}

const OVERFLOW =
  /request too large|reduce your message size|tokens per minute.*requested|\(context_length\)|prompt is too long|input is too long|context (length|window)/i;

const RULES: Rule[] = [
  {
    test: /storage_unavailable|armazenamento de documentos/i,
    title: 'O armazenamento de documentos está indisponível',
    hint: 'Tente novamente em instantes. Em Configurações > Armazenamento de documentos você pode testar a conexão.',
  },
  {
    test: /notebooklm não configurado|notebooklm_not_configured/i,
    title: 'O NotebookLM ainda não está configurado',
    hint: 'Abra Biblioteca > NotebookLM (experimental) e entre com o Google.',
  },
  {
    test: /credenciais do notebooklm|notebooklm_auth|missing required cookies/i,
    title: 'As credenciais do NotebookLM expiraram',
    hint: 'Abra Biblioteca > NotebookLM (experimental) e entre com o Google novamente.',
  },
  {
    test: /notebooklm indispon|notebooklm_(unavailable|timeout|bad_response|cli_missing|rate_limited)|cli do notebooklm|limite de uso do notebooklm|notebooklm demorou/i,
    title: 'O NotebookLM não respondeu',
    hint: 'O serviço é não oficial e pode falhar. Tente de novo mais tarde ou use uma biblioteca Local.',
  },
  {
    test: /arquivo maior que|file_too_large|payload too large|request entity too large|\b413\b/i,
    title: 'O arquivo é grande demais',
    hint: 'O limite é de 20 MB por arquivo (10 MB para imagens). Divida o documento ou comprima-o.',
  },
  {
    test: OVERFLOW,
    agentOnly: true,
    title: 'A conversa do agente ficou grande demais para este modelo',
    hint: 'Use "Derivar" para continuar com um resumo da conversa.',
  },
  {
    test: OVERFLOW,
    title: 'A conversa ficou grande demais para este modelo',
    hint: 'O limite gratuito de tokens por minuto foi ultrapassado. Inicie uma nova conversa, desligue o MCP ou use outra conexão.',
  },
  {
    test: /limit:\s*0|exceeded your current quota|quota_exhausted|insufficient[_ ]funds|credits/i,
    title: 'A cota gratuita deste provider acabou',
    hint: 'Aguarde o reset da cota (normalmente à meia-noite UTC), troque de modelo ou use outra conexão.',
  },
  {
    test: /rate limit|rate_limited|too many requests|\b429\b/i,
    title: 'Muitas requisições em pouco tempo',
    hint: 'O Thinkflow tenta a próxima conexão sozinho. Se persistir, aguarde alguns segundos.',
  },
  {
    test: /model_unavailable|does not exist|not found for account|decommissioned|no access/i,
    title: 'O modelo escolhido não está disponível nesta conta',
    hint: 'Selecione "Auto" no seletor de modelos para o Thinkflow escolher um que funcione.',
  },
  {
    test: /\(auth\)|invalid api key|unauthorized|\b40[13]\b/i,
    title: 'A chave de API foi recusada',
    hint: 'Confira se a chave da conexão está correta e ativa.',
  },
  {
    test: /nenhuma conexão disponível|no_connection/i,
    title: 'Nenhuma conexão disponível agora',
    hint: 'Todas estão desativadas ou em cooldown. Vá em Conexões e use "Liberar" ou cadastre outra.',
  },
  {
    test: /failed to fetch|networkerror|network|econn|timeout|timed out/i,
    title: 'Não foi possível se conectar',
    hint: 'Verifique sua internet e se o servidor do Thinkflow está rodando.',
  },
];

export function friendlyError(raw: string, context: FriendlyErrorContext = {}): FriendlyError {
  const detail = raw.trim();
  const rule = RULES.find((r) => (!r.agentOnly || context.agent) && r.test.test(detail));
  if (rule) return { title: rule.title, hint: rule.hint, detail };
  const short = detail.length > 140 ? `${detail.slice(0, 140)}…` : detail;
  return { title: short || 'Algo deu errado', detail };
}
