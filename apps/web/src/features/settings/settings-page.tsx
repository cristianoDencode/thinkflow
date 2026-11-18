import { notify } from '../../lib/notify';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiKeyDto, HistorySettings, ModelAliases } from '@thinkflow/shared';
import { Check, Copy, KeyRound, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card, PageHeader } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { keys, useApiKeys, useAuthStatus, useModelOptions, useSettings } from '../../lib/queries';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { cn, timeAgo } from '../../lib/utils';
import { OneDriveSettings } from '../integrations/onedrive-settings';
import { StorageSettings } from './storage-settings';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="scrollbar-thin overflow-x-auto rounded-xl border border-border bg-surface-2 p-4 pr-12 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-2 right-2"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            notify.error('Não foi possível copiar');
          }
        }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

interface PresidioHealth {
  configured: boolean;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

const DEFAULT_HISTORY: HistorySettings = {
  contextBudgetTokens: 16_000,
  recentTurns: 6,
  summaryModel: '',
  maxConversations: 500,
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const { data: models = [] } = useModelOptions();
  const { data: apiKeys = [] } = useApiKeys();
  const { preference, setPreference } = useTheme();

  const [profile, setProfile] = useState({ name: '', title: '' });
  const [aliases, setAliases] = useState<ModelAliases>({
    default: '',
    opus: '',
    sonnet: '',
    haiku: '',
  });
  const [cwd, setCwd] = useState('');
  const [history, setHistory] = useState<HistorySettings>(DEFAULT_HISTORY);
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [newKeyName, setNewKeyName] = useState('Claude Code');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [presidioUrl, setPresidioUrl] = useState('');
  const [presidioHealth, setPresidioHealth] = useState<PresidioHealth | null>(null);
  const [presidioTesting, setPresidioTesting] = useState(false);

  useEffect(() => {
    if (auth?.user) setProfile({ name: auth.user.name, title: auth.user.title });
  }, [auth?.user]);
  useEffect(() => {
    if (settings) {
      setAliases(settings.aliases);
      setCwd(settings.agentDefaultCwd);
      setHistory(settings.history ?? DEFAULT_HISTORY);
      setPresidioUrl(settings.privacy?.presidioUrl ?? '');
    }
  }, [settings]);

  const save = async (
    fn: () => Promise<unknown>,
    message: string,
    invalidate: readonly (readonly string[])[],
  ) => {
    try {
      await fn();
      notify.success(message);
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const testPresidio = async () => {
    setPresidioTesting(true);
    try {
      setPresidioHealth(await api.get<PresidioHealth>('/api/settings/privacy/presidio'));
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setPresidioTesting(false);
    }
  };

  const baseUrl = settings?.baseUrl ?? 'http://localhost:3737';
  const model = aliases.default || models[0]?.id || 'thinkflow/default';
  const keyPlaceholder = createdKey ?? '<sua API key do Thinkflow>';
  const claudeSnippet = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: keyPlaceholder,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: aliases.opus || model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: aliases.sonnet || model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: aliases.haiku || model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
    null,
    2,
  );
  const openAISnippet = `curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Olá!"}]}'`;

  const aliasOptions = (
    <>
      <option value="">— não mapear —</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </>
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Configurações"
        description="Perfil, aparência, chaves de acesso ao roteador e integração com o Claude Code."
      />
      <div className="flex flex-col gap-5">
        <Section
          title="Claude Code (CLI e extensão do VS Code)"
          description="O Claude Code continua com todos os recursos (MCP, plan mode, comandos), mas as chamadas de modelo passam pelo roteador do Thinkflow."
        >
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Crie uma API key abaixo (ela só é mostrada uma vez).</li>
            <li>
              Cole o bloco em <code className="font-mono text-fg">~/.claude/settings.json</code> (no
              Windows:{' '}
              <code className="font-mono text-fg">%USERPROFILE%\.claude\settings.json</code>).
            </li>
            <li>
              Reinicie o Claude Code / VS Code. Os pedidos aparecerão em Conexões → Atividade.
            </li>
          </ol>
          <CopyBlock text={claudeSnippet} label="Copiar configuração do Claude Code" />
          <p className="mt-4 mb-2 text-sm text-muted">
            Qualquer cliente compatível com OpenAI também funciona:
          </p>
          <CopyBlock text={openAISnippet} label="Copiar exemplo curl" />
        </Section>

        <Section
          title="Mapeamento de modelos"
          description="Quando um cliente (ex.: Claude Code) pede um modelo claude-opus/sonnet/haiku ou um nome desconhecido, o Thinkflow usa estes combos/modelos."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(
              [
                ['default', 'Padrão (qualquer modelo desconhecido)'],
                ['sonnet', 'Pedidos "sonnet"'],
                ['opus', 'Pedidos "opus"'],
                ['haiku', 'Pedidos "haiku" (tarefas rápidas)'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label} htmlFor={`alias-${key}`}>
                <Select
                  id={`alias-${key}`}
                  value={aliases[key]}
                  onChange={(e) => setAliases((a) => ({ ...a, [key]: e.target.value }))}
                >
                  {aliasOptions}
                </Select>
              </Field>
            ))}
          </div>
          <Field
            label="Pasta de trabalho padrão do modo Agente"
            htmlFor="agent-cwd"
            className="mt-4"
            hint="Onde o agente pode ler/editar arquivos. Padrão: sua pasta de usuário."
          >
            <Input
              id="agent-cwd"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="D:\\projetos\\meu-projeto"
            />
          </Field>
          <Button
            className="mt-4"
            onClick={() =>
              void save(
                () => api.put('/api/settings', { aliases, agentDefaultCwd: cwd }),
                'Configurações salvas',
                [keys.settings],
              )
            }
          >
            Salvar
          </Button>
        </Section>

        <Section
          title="Histórico e contexto"
          description="Conversas longas não são enviadas inteiras ao modelo: as mensagens mais antigas viram um resumo contínuo e as mais recentes seguem na íntegra. Nada é apagado do histórico."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Orçamento de contexto (tokens)"
              htmlFor="history-budget"
              hint="Máximo estimado enviado ao modelo por mensagem. Se o provedor aceitar menos, o limite menor vale."
            >
              <Input
                id="history-budget"
                type="number"
                min={2000}
                max={1000000}
                step={1000}
                value={history.contextBudgetTokens}
                onChange={(e) =>
                  setHistory((h) => ({ ...h, contextBudgetTokens: Number(e.target.value) }))
                }
              />
            </Field>
            <Field
              label="Trocas recentes mantidas"
              htmlFor="history-turns"
              hint="Quantas trocas (pergunta + resposta) recentes seguem sem resumir."
            >
              <Input
                id="history-turns"
                type="number"
                min={1}
                max={50}
                value={history.recentTurns}
                onChange={(e) => setHistory((h) => ({ ...h, recentTurns: Number(e.target.value) }))}
              />
            </Field>
            <Field
              label="Modelo do resumo"
              htmlFor="history-summary-model"
              hint="Os resumos consomem tokens do modelo escolhido (veja em Uso)."
            >
              <Select
                id="history-summary-model"
                value={history.summaryModel}
                onChange={(e) => setHistory((h) => ({ ...h, summaryModel: e.target.value }))}
              >
                <option value="">o mesmo da conversa</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Máximo de conversas guardadas"
              htmlFor="history-max"
              hint="Acima disso, as mais antigas (exceto as fixadas) serão removidas."
            >
              <Input
                id="history-max"
                type="number"
                min={10}
                max={10000}
                value={history.maxConversations}
                onChange={(e) =>
                  setHistory((h) => ({ ...h, maxConversations: Number(e.target.value) }))
                }
              />
            </Field>
          </div>
          <Button
            className="mt-4"
            onClick={() =>
              void save(() => api.put('/api/settings', { history }), 'Configurações salvas', [
                keys.settings,
              ])
            }
          >
            Salvar
          </Button>
        </Section>

        <Section
          title="Privacidade da IA"
          description="Antes de qualquer texto sair para um provedor de IA (chat, dados, relatórios, resumos, agente e /v1), CPF, CNPJ, e-mail, telefone, nomes e outros dados pessoais viram códigos como [CPF_1]. Você vê os valores reais; a IA só vê os códigos."
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Proteger dados pessoais antes de enviar à IA</p>
              <p className="text-xs text-muted">
                Vale também para modelos locais (Ollama, LM Studio): o filtro roda no roteador.
              </p>
            </div>
            <Switch
              label="Proteger dados pessoais antes de enviar à IA"
              checked={settings?.privacy?.enabled !== false}
              disabled={!settings}
              onChange={(enabled) =>
                void save(
                  () => api.put('/api/settings', { privacy: { enabled } }),
                  enabled ? 'Proteção de dados ativada' : 'Proteção de dados desativada',
                  [keys.settings],
                )
              }
            />
          </div>
          {settings?.privacy?.enabled === false && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              Proteção desativada: dados pessoais serão enviados aos provedores de IA como estão.
            </p>
          )}
          <p className="mt-3 text-xs text-muted">
            Imagens e PDFs anexados não são lidos pelo filtro e seguem sem proteção (prefira o OCR
            local na Biblioteca).
          </p>
          <div className="mt-5 border-t border-border pt-4">
            <Field
              label="URL do Presidio"
              htmlFor="presidio-url"
              hint="Opcional. Detector extra de nomes e endereços em texto livre (docker compose --profile privacy). Vazio usa PRIVACY_PRESIDIO_URL, se definida; sem nenhum, só os detectores nativos."
            >
              <Input
                id="presidio-url"
                value={presidioUrl}
                placeholder="http://presidio:3000"
                onChange={(e) => {
                  setPresidioUrl(e.target.value);
                  setPresidioHealth(null);
                }}
              />
            </Field>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                disabled={!settings || presidioUrl.trim() === (settings.privacy?.presidioUrl ?? '')}
                onClick={() =>
                  void save(
                    () =>
                      api.put('/api/settings', { privacy: { presidioUrl: presidioUrl.trim() } }),
                    'URL do Presidio salva',
                    [keys.settings],
                  )
                }
              >
                Salvar
              </Button>
              <Button
                variant="ghost"
                disabled={presidioTesting}
                onClick={() => void testPresidio()}
              >
                {presidioTesting ? 'Testando…' : 'Testar'}
              </Button>
              {presidioHealth && (
                <Badge
                  tone={
                    !presidioHealth.configured
                      ? 'neutral'
                      : presidioHealth.reachable
                        ? 'success'
                        : 'danger'
                  }
                >
                  {!presidioHealth.configured
                    ? 'Não configurado'
                    : presidioHealth.reachable
                      ? `Conectado${presidioHealth.latencyMs !== undefined ? ` (${presidioHealth.latencyMs} ms)` : ''}`
                      : `Indisponível${presidioHealth.error ? `: ${presidioHealth.error}` : ''}`}
                </Badge>
              )}
            </div>
          </div>
        </Section>

        <Section
          title="API keys do roteador"
          description="Usadas por clientes externos (Claude Code, scripts, outros apps) para chamar /v1 do Thinkflow."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Nome da nova chave"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Nome da chave"
            />
            <Button
              onClick={() =>
                void save(
                  async () => {
                    const result = await api.post<{ key: string; apiKey: ApiKeyDto }>(
                      '/api/api-keys',
                      { name: newKeyName },
                    );
                    setCreatedKey(result.key);
                  },
                  'Chave criada — copie agora, ela não será mostrada novamente',
                  [keys.apiKeys],
                )
              }
            >
              <KeyRound className="h-4 w-4" /> Criar chave
            </Button>
          </div>
          {createdKey && (
            <div className="mt-3">
              <CopyBlock text={createdKey} label="Copiar nova chave" />
            </div>
          )}
          <ul className="mt-4 divide-y divide-border">
            {apiKeys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{k.name}</p>
                  <p className="text-xs text-muted">
                    <span className="font-mono">{k.prefix}…</span> · criada {timeAgo(k.createdAt)} ·
                    último uso {timeAgo(k.lastUsedAt)}
                  </p>
                </div>
                <ConfirmButton
                  label={`Revogar ${k.name}`}
                  onConfirm={() =>
                    void save(() => api.del(`/api/api-keys/${k.id}`), 'Chave revogada', [
                      keys.apiKeys,
                    ])
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </ConfirmButton>
              </li>
            ))}
            {apiKeys.length === 0 && (
              <li className="py-2 text-sm text-muted">Nenhuma chave criada.</li>
            )}
          </ul>
        </Section>

        <Section
          title="Armazenamento de documentos"
          description="Onde ficam os HTML e PDF dos relatórios gerados."
        >
          <StorageSettings />
        </Section>

        <Section
          title="OneDrive (Word Online)"
          description="Cria um documento novo no seu OneDrive pessoal para cada caso de teste e abre no Word Online. Nunca sobrescreve arquivos existentes."
        >
          <OneDriveSettings />
        </Section>

        <Section title="Aparência">
          <div
            className="inline-flex rounded-xl border border-border p-1"
            role="radiogroup"
            aria-label="Tema"
          >
            {(
              [
                { value: 'light', label: 'Claro', icon: Sun },
                { value: 'dark', label: 'Escuro', icon: Moon },
                { value: 'system', label: 'Sistema', icon: Monitor },
              ] as { value: ThemePreference; label: string; icon: typeof Sun }[]
            ).map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={preference === t.value}
                onClick={() => setPreference(t.value)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm',
                  preference === t.value
                    ? 'bg-accent-soft text-accent-text'
                    : 'text-muted hover:text-fg',
                )}
              >
                <t.icon className="h-4 w-4" /> {t.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Perfil">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nome" htmlFor="profile-name">
              <Input
                id="profile-name"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field label="Cargo" htmlFor="profile-title">
              <Input
                id="profile-title"
                value={profile.title}
                onChange={(e) => setProfile((p) => ({ ...p, title: e.target.value }))}
              />
            </Field>
          </div>
          <Button
            className="mt-4"
            onClick={() =>
              void save(() => api.put('/api/profile', profile), 'Perfil atualizado', [keys.auth])
            }
          >
            Salvar perfil
          </Button>

          <div className="mt-6 grid grid-cols-1 gap-4 border-t border-border pt-5 sm:grid-cols-2">
            <Field label="Senha atual" htmlFor="pw-current">
              <Input
                id="pw-current"
                type="password"
                value={passwords.current}
                onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))}
              />
            </Field>
            <Field label="Nova senha" htmlFor="pw-next" hint="Mínimo de 8 caracteres">
              <Input
                id="pw-next"
                type="password"
                value={passwords.next}
                onChange={(e) => setPasswords((p) => ({ ...p, next: e.target.value }))}
              />
            </Field>
          </div>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() =>
              void save(
                async () => {
                  await api.post('/api/profile/password', passwords);
                  setPasswords({ current: '', next: '' });
                },
                'Senha alterada',
                [],
              )
            }
          >
            Alterar senha
          </Button>
        </Section>
      </div>
    </div>
  );
}
