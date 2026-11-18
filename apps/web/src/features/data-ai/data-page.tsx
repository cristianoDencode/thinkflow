import { useQueryClient } from '@tanstack/react-query';
import type { ConversationDetailDto } from '@thinkflow/shared';
import { Database, DatabaseZap, History, Plug, Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/card';
import { Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { modalState } from '../../lib/background-location';
import { keys, useDatabases, useModelOptions } from '../../lib/queries';
import { streamChat } from '../../lib/sse';
import { cn } from '../../lib/utils';
import { applyStreamEvent, fromDto } from '../chat/chat-reducer';
import type { ComposerHandle } from '../chat/composer';
import { HistoryDrawer } from '../chat/history-drawer';
import { AssistantMessage, UserMessage } from '../chat/message-view';
import { INITIAL_STEPS, type UiMessage } from '../chat/types';
import { DataComposer } from './data-composer';

const SETTINGS_KEY = 'thinkflow-data';

const EXAMPLES = [
  'Quais tabelas guardam os débitos do IPTU?',
  'Mostre os lançamentos do exercício com valor diferente do calculado',
  'Encontre contribuintes duplicados pelo CPF',
  'Resumo de arrecadação por mês no último exercício',
];

interface DataSettings {
  model: string;
  useMcp: boolean;
}

function loadSettings(): DataSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<DataSettings>;
    return {
      model: typeof stored.model === 'string' ? stored.model : '',
      useMcp: stored.useMcp !== false,
    };
  } catch {
    return { model: '', useMcp: true };
  }
}

/** "Dados com IA": ask in Portuguese (the AI explores and runs read-only SQL) or type SQL. */
export function DataPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationId = searchParams.get('c');
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data: databases = [], isLoading: loadingDatabases } = useDatabases();
  const { data: models = [] } = useModelOptions();

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settings, setSettings] = useState<DataSettings>(loadSettings);
  const [databaseId, setDatabaseId] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const ownConversationRef = useRef<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

  // pick a default model once options load
  useEffect(() => {
    if (models.length === 0) return;
    if (!settings.model || !models.some((m) => m.id === settings.model))
      setSettings((s) => ({ ...s, model: models[0]!.id }));
  }, [models, settings.model]);

  // the default connection is preselected; a deleted one cannot stay selected
  useEffect(() => {
    if (loadingDatabases) return;
    if (databaseId && databases.some((d) => d.id === databaseId)) return;
    const fallback = databases.find((d) => d.isDefault) ?? databases[0];
    setDatabaseId(fallback?.id ?? '');
  }, [databases, databaseId, loadingDatabases]);

  // load a conversation when the URL changes (but not the one we are streaming into)
  useEffect(() => {
    if (!conversationId) {
      if (!ownConversationRef.current) setMessages([]);
      return;
    }
    if (conversationId === ownConversationRef.current) return;
    let cancelled = false;
    api
      .get<ConversationDetailDto>(`/api/conversations/${conversationId}`)
      .then((detail) => {
        if (cancelled) return;
        if (detail.mode !== 'data') {
          navigate(`/?c=${encodeURIComponent(detail.id)}`, { replace: true });
          return;
        }
        setMessages(detail.messages.map(fromDto));
        if (detail.databaseId) setDatabaseId(detail.databaseId);
        if (detail.model) setSettings((s) => ({ ...s, model: detail.model }));
      })
      .catch(() => !cancelled && setSearchParams({}, { replace: true }));
    return () => {
      cancelled = true;
    };
  }, [conversationId, setSearchParams, navigate]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const updateLast = useCallback((fn: (m: UiMessage) => UiMessage) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = fn(next[next.length - 1]!);
      return next;
    });
  }, []);

  const send = async (text: string, direct: boolean) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    const stamp = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: `local-user-${stamp}`, role: 'user', content: text, toolCalls: [] },
      {
        id: `local-assistant-${stamp}`,
        role: 'assistant',
        content: '',
        toolCalls: [],
        steps: { ...INITIAL_STEPS },
        streaming: true,
        ...(direct ? { direct: true } : {}),
      },
    ]);

    try {
      await streamChat(
        {
          ...(conversationId ? { conversationId } : {}),
          mode: 'data',
          // a typed query needs no model, but the request always carries one
          model: settings.model || 'thinkflow/default',
          content: text,
          attachments: [],
          useMcp: settings.useMcp,
          databaseId,
          ...(direct ? { directSql: true } : {}),
        },
        (event) => {
          if (event.type === 'conversation') {
            ownConversationRef.current = event.conversationId;
            if (event.conversationId !== conversationId)
              setSearchParams({ c: event.conversationId }, { replace: true });
            return;
          }
          updateLast((m) => applyStreamEvent(m, event));
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) updateLast((m) => ({ ...m, error: errorMessage(err) }));
    } finally {
      updateLast((m) => ({
        ...m,
        streaming: false,
        steps: Object.fromEntries(
          Object.entries(m.steps ?? INITIAL_STEPS).map(([k, v]) => [
            k,
            v === 'active' || v === 'pending' ? 'skipped' : v,
          ]),
        ) as UiMessage['steps'],
        // a card still open when the stream ends was closed by the server (tokenized everything)
        ...(m.reviews?.some((r) => !r.closed)
          ? { reviews: m.reviews.map((r) => (r.closed ? r : { ...r, closed: 'aborted' as const })) }
          : {}),
        ...(controller.signal.aborted && !m.error ? { error: 'Geração interrompida' } : {}),
      }));
      setStreaming(false);
      abortRef.current = null;
      void queryClient.invalidateQueries({ queryKey: keys.conversations });
    }
  };

  // "Rodar" on the SQL of an answer: the same path as "Executar SQL" (kept stable so the
  // messages already on screen do not re-render on every streamed token)
  const sendRef = useRef(send);
  sendRef.current = send;
  const runSql = useCallback((sql: string) => void sendRef.current(sql, true), []);
  const sqlActions = useMemo(
    () => ({
      onRun: runSql,
      runDisabledReason: streaming
        ? 'Aguarde a resposta terminar'
        : !databaseId
          ? 'Selecione uma conexão'
          : null,
    }),
    [runSql, streaming, databaseId],
  );

  const newConversation = () => {
    abortRef.current?.abort();
    ownConversationRef.current = null;
    setMessages([]);
    setSearchParams({}, { replace: false });
  };

  const selectConversation = (id: string | null) => {
    abortRef.current?.abort();
    ownConversationRef.current = null;
    if (id) setSearchParams({ c: id });
    else newConversation();
  };

  const setFeedback = (id: string, value: 'up' | 'down' | null) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, feedback: value } : m)));

  const empty = messages.length === 0;
  const noConnection = !loadingDatabases && databases.length === 0;
  const disabledReason = {
    ...(!databaseId ? { run: 'Selecione uma conexão' } : {}),
    ...(!databaseId
      ? { ask: 'Selecione uma conexão' }
      : !settings.model
        ? { ask: 'Selecione um modelo ou combo' }
        : {}),
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-80" aria-hidden />

      <div className="relative flex flex-wrap items-center gap-2 px-4 pt-4 sm:px-8">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <Database className="h-4 w-4 text-accent-text" aria-hidden />
            <Select
              aria-label="Conexão"
              value={databaseId}
              onChange={(e) => setDatabaseId(e.target.value)}
              disabled={databases.length === 0 || streaming}
              className="h-8 w-auto max-w-64 rounded-lg py-0 text-xs"
            >
              {databases.length === 0 && <option value="">Sem conexões</option>}
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </span>
          <Link
            to="/databases"
            state={modalState(location)}
            className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Gerenciar conexões
          </Link>

          {models.length > 0 ? (
            <Select
              aria-label="Modelo"
              value={settings.model}
              onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
              className="h-8 w-auto max-w-64 rounded-lg py-0 text-xs"
            >
              {!models.some((m) => m.id === settings.model) && (
                <option value="">Selecione um modelo…</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          ) : (
            <Link to="/connections" className="text-xs text-accent-text underline">
              Cadastre uma conexão de IA para escolher um modelo
            </Link>
          )}

          <button
            type="button"
            onClick={() => setSettings((s) => ({ ...s, useMcp: !s.useMcp }))}
            aria-pressed={settings.useMcp}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium',
              settings.useMcp
                ? 'border-transparent bg-accent-soft text-accent-text'
                : 'border-border text-muted',
            )}
            title="Usa os servidores MCP para mapear menus/rotinas do sistema"
          >
            <Plug className="h-3.5 w-3.5" aria-hidden /> MCP{' '}
            {settings.useMcp ? 'ligado' : 'desligado'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="h-4 w-4" /> Histórico
          </Button>
          {!empty && (
            <Button variant="secondary" size="sm" onClick={newConversation}>
              <Plus className="h-4 w-4" /> Nova conversa
            </Button>
          )}
        </div>
      </div>

      <div className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-6">
          {empty && noConnection && (
            <section className="pt-8 sm:pt-14">
              <EmptyState
                icon={<DatabaseZap className="h-6 w-6" />}
                title="Nenhuma conexão cadastrada"
                description="Cadastre um banco Postgres para perguntar em português ou rodar SQL. Tudo é somente leitura."
                action={
                  <Link
                    to="/databases"
                    state={modalState(location)}
                    className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm hover:bg-accent-hover"
                  >
                    <Plus className="h-4 w-4" aria-hidden /> Cadastrar conexão
                  </Link>
                }
              />
            </section>
          )}

          {empty && !noConnection && (
            <section className="pt-6 sm:pt-12">
              <div className="flex items-center gap-5 sm:gap-7">
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-3xl bg-accent-soft text-accent-text sm:h-24 sm:w-24">
                  <DatabaseZap className="h-8 w-8 sm:h-12 sm:w-12" strokeWidth={1.5} aria-hidden />
                </span>
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
                    Dados com IA
                  </h1>
                  <p className="mt-2 max-w-2xl text-base text-muted sm:text-xl">
                    Pergunte em português ou cole uma SQL. A IA explora o banco e executa consultas;
                    tudo é somente leitura.
                  </p>
                </div>
              </div>
              <div
                className="mt-8 grid grid-cols-1 gap-3 sm:mt-12 sm:grid-cols-2"
                aria-label="Exemplos de perguntas"
              >
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => composerRef.current?.fill(example)}
                    className="cursor-pointer rounded-2xl border border-border bg-surface/80 px-5 py-4 text-left text-[15px] leading-snug transition-colors hover:border-border-strong hover:bg-surface-hover"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </section>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                onFeedback={setFeedback}
                databaseId={databaseId || null}
                sqlActions={sqlActions}
              />
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="relative px-4 pt-2 pb-4 sm:px-8 sm:pb-6">
        <div className="mx-auto w-full max-w-5xl">
          <DataComposer
            ref={composerRef}
            streaming={streaming}
            disabledReason={disabledReason}
            onAsk={(text) => void send(text, false)}
            onRunSql={(text) => void send(text, true)}
            onStop={() => abortRef.current?.abort()}
          />
        </div>
      </div>

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        activeId={conversationId}
        onSelect={selectConversation}
        scope="data"
      />
    </div>
  );
}
