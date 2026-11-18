import { notify } from '../../lib/notify';
import { useQueryClient } from '@tanstack/react-query';
import type { McpServerDto, McpServerInput, McpTestResultDto } from '@thinkflow/shared';
import { Globe, Pencil, Play, Plus, Puzzle, Terminal, Trash2, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '../../components/ui/card';
import { ConfirmButton, Dialog } from '../../components/ui/dialog';
import { Field, Input, Switch, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { keys, useMcpServers } from '../../lib/queries';
import { cn, parseKeyValueLines } from '../../lib/utils';

interface Preset {
  label: string;
  description: string;
  value: Partial<Draft>;
}

interface Draft {
  transport: 'stdio' | 'http';
  name: string;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  enabled: boolean;
}

const EMPTY: Draft = {
  transport: 'stdio',
  name: '',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  enabled: true,
};

const PRESETS: Preset[] = [
  {
    label: 'Arquivos locais',
    description: 'Lê e lista arquivos de uma pasta',
    value: {
      transport: 'stdio',
      name: 'filesystem',
      command: 'npx',
      args: '-y\n@modelcontextprotocol/server-filesystem\nC:\\caminho\\da\\pasta',
    },
  },
  {
    label: 'Memória',
    description: 'Grafo de conhecimento persistente',
    value: {
      transport: 'stdio',
      name: 'memory',
      command: 'npx',
      args: '-y\n@modelcontextprotocol/server-memory',
    },
  },
  {
    label: 'Fetch (web)',
    description: 'Busca páginas da web (requer uv/uvx)',
    value: { transport: 'stdio', name: 'fetch', command: 'uvx', args: 'mcp-server-fetch' },
  },
  {
    label: 'Servidor HTTP',
    description: 'Qualquer servidor MCP remoto',
    value: { transport: 'http', name: 'remoto', url: 'https://exemplo.com/mcp' },
  },
];

export function McpPage() {
  const { data: servers = [] } = useMcpServers();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{
    open: boolean;
    editing: McpServerDto | null;
    preset?: Partial<Draft>;
  }>({
    open: false,
    editing: null,
  });
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, McpTestResultDto>>({});

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.mcp });

  const test = async (server: McpServerDto) => {
    setTesting(server.id);
    try {
      const result = await api.post<McpTestResultDto>(`/api/mcp/${server.id}/test`);
      setResults((prev) => ({ ...prev, [server.id]: result }));
      if (result.ok) notify.success(`${server.name}: ${result.message}`);
      else notify.error(`${server.name}: ${result.message}`);
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setTesting(null);
    }
  };

  const toggle = async (server: McpServerDto, enabled: boolean) => {
    try {
      await api.patch(`/api/mcp/${server.id}/enabled`, { enabled });
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const remove = async (server: McpServerDto) => {
    try {
      await api.del(`/api/mcp/${server.id}`);
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="MCP — fontes conectadas"
        description="Servidores MCP ativos ficam disponíveis como ferramentas no chat e no modo Agente. Variáveis de ambiente e headers são armazenados criptografados."
        actions={
          <Button onClick={() => setDialog({ open: true, editing: null })}>
            <Plus className="h-4 w-4" /> Novo servidor
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setDialog({ open: true, editing: null, preset: p.value })}
            className="cursor-pointer rounded-xl border border-dashed border-border-strong px-4 py-3 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Plus className="h-4 w-4 text-accent-text" /> {p.label}
            </span>
            <span className="mt-0.5 block text-xs text-muted">{p.description}</span>
          </button>
        ))}
      </div>

      {servers.length === 0 ? (
        <EmptyState
          icon={<Puzzle className="h-6 w-6" />}
          title="Nenhum servidor MCP"
          description="Conecte servidores MCP (stdio ou HTTP) para dar ferramentas à IA: arquivos, bancos, APIs internas, Jira, GitHub…"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {servers.map((server) => {
            const result = results[server.id];
            return (
              <Card key={server.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
                      {server.transport === 'stdio' ? (
                        <Terminal className="h-4 w-4" />
                      ) : (
                        <Globe className="h-4 w-4" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-medium">{server.name}</h3>
                        <Badge>{server.transport}</Badge>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted">
                        {server.transport === 'stdio'
                          ? [server.command, ...(server.args ?? [])].join(' ')
                          : server.url}
                      </p>
                      {server.envKeys?.length || server.headerKeys?.length ? (
                        <p className="mt-0.5 text-xs text-subtle">
                          {server.transport === 'stdio' ? 'env: ' : 'headers: '}
                          {(server.envKeys ?? server.headerKeys ?? []).join(', ')}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <Switch
                    checked={server.enabled}
                    onChange={(v) => void toggle(server, v)}
                    label={`Ativar ${server.name}`}
                  />
                </div>

                {result && (
                  <div
                    className={cn(
                      'rounded-lg px-3 py-2 text-xs',
                      result.ok ? 'bg-success-soft' : 'bg-danger-soft text-danger',
                    )}
                  >
                    <p className={cn(result.ok && 'text-success')}>{result.message}</p>
                    {result.tools.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {result.tools.map((tool) => (
                          <span
                            key={tool.name}
                            title={tool.description}
                            className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 font-mono text-fg"
                          >
                            <Wrench className="h-3 w-3 text-accent-text" /> {tool.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void test(server)}
                    loading={testing === server.id}
                  >
                    {testing !== server.id && <Play className="h-3.5 w-3.5" />} Testar
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDialog({ open: true, editing: server })}
                    aria-label={`Editar ${server.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <ConfirmButton
                    label={`Excluir ${server.name}`}
                    onConfirm={() => void remove(server)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <McpDialog
        open={dialog.open}
        editing={dialog.editing}
        preset={dialog.preset}
        onClose={() => setDialog({ open: false, editing: null })}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

function McpDialog({
  open,
  editing,
  preset,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: McpServerDto | null;
  preset: Partial<Draft> | undefined;
  onClose(): void;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDraft({
        transport: editing.transport,
        name: editing.name,
        command: editing.command ?? '',
        args: (editing.args ?? []).join('\n'),
        env: '',
        url: editing.url ?? '',
        headers: '',
        enabled: editing.enabled,
      });
    } else {
      setDraft({ ...EMPTY, ...preset });
    }
  }, [open, editing, preset]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async () => {
    setSaving(true);
    try {
      const env = parseKeyValueLines(draft.env, '=');
      const headers = parseKeyValueLines(draft.headers, ':');
      const body: McpServerInput =
        draft.transport === 'stdio'
          ? {
              transport: 'stdio',
              name: draft.name,
              command: draft.command,
              args: draft.args
                .split(/\r?\n/)
                .map((a) => a.trim())
                .filter(Boolean),
              enabled: draft.enabled,
              // when editing, an empty field keeps the stored secrets
              ...(editing && !draft.env.trim() ? {} : { env }),
            }
          : {
              transport: 'http',
              name: draft.name,
              url: draft.url,
              enabled: draft.enabled,
              ...(editing && !draft.headers.trim() ? {} : { headers }),
            };
      if (editing) await api.put(`/api/mcp/${editing.id}`, body);
      else await api.post('/api/mcp', body);
      notify.success('Servidor MCP salvo');
      onSaved();
      onClose();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Editar ${editing.name}` : 'Novo servidor MCP'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          className="inline-flex self-start rounded-xl border border-border p-1"
          role="radiogroup"
          aria-label="Transporte"
        >
          {(['stdio', 'http'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={draft.transport === t}
              onClick={() => set('transport', t)}
              className={cn(
                'cursor-pointer rounded-lg px-3 py-1.5 text-sm',
                draft.transport === t ? 'bg-accent-soft text-accent-text' : 'text-muted',
              )}
            >
              {t === 'stdio' ? 'Local (stdio)' : 'Remoto (HTTP)'}
            </button>
          ))}
        </div>
        <Field
          label="Nome"
          htmlFor="mcp-name"
          hint='Letras, números, "_" e "-". Vira o prefixo das ferramentas (mcp__nome__ferramenta).'
        >
          <Input id="mcp-name" value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        {draft.transport === 'stdio' ? (
          <>
            <Field label="Comando" htmlFor="mcp-command" hint="Ex.: npx, uvx, node, python, docker">
              <Input
                id="mcp-command"
                value={draft.command}
                onChange={(e) => set('command', e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Argumentos (um por linha)" htmlFor="mcp-args">
              <Textarea
                id="mcp-args"
                rows={4}
                value={draft.args}
                onChange={(e) => set('args', e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
            <Field
              label="Variáveis de ambiente (CHAVE=valor por linha)"
              htmlFor="mcp-env"
              hint={
                editing?.envKeys?.length
                  ? `Salvas: ${editing.envKeys.join(', ')} — deixe vazio para manter`
                  : 'Opcional'
              }
            >
              <Textarea
                id="mcp-env"
                rows={3}
                value={draft.env}
                onChange={(e) => set('env', e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="URL"
              htmlFor="mcp-url"
              hint="Streamable HTTP (com fallback automático para SSE)"
            >
              <Input
                id="mcp-url"
                value={draft.url}
                onChange={(e) => set('url', e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field
              label="Headers (Nome: valor por linha)"
              htmlFor="mcp-headers"
              hint={
                editing?.headerKeys?.length
                  ? `Salvos: ${editing.headerKeys.join(', ')} — deixe vazio para manter`
                  : 'Ex.: Authorization: Bearer …'
              }
            >
              <Textarea
                id="mcp-headers"
                rows={3}
                value={draft.headers}
                onChange={(e) => set('headers', e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
          </>
        )}
        <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
          <span className="text-sm">Ativo</span>
          <Switch
            checked={draft.enabled}
            onChange={(v) => set('enabled', v)}
            label="Servidor ativo"
          />
        </div>
      </div>
    </Dialog>
  );
}
