import { useQueryClient } from '@tanstack/react-query';
import type {
  ChatAttachment,
  ConversationDetailDto,
  ConversationDto,
  ConversationSummaryDto,
  ReportDto,
  ReportTemplateSummaryDto,
  TemplateKind,
} from '@thinkflow/shared';
import {
  ChartColumn,
  FileText,
  History,
  Image,
  Lightbulb,
  Plus,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { notify } from '../../lib/notify';
import { LogoMark } from '../../components/layout/logo';
import { Button } from '../../components/ui/button';
import { ApiError, api, errorMessage } from '../../lib/api';
import { keys, useAuthStatus, useLibraries, useModelOptions, useSettings } from '../../lib/queries';
import { streamChat } from '../../lib/sse';
import { firstName } from '../../lib/utils';
import { applyStreamEvent, fromDto } from './chat-reducer';
import { ContextSummary } from './context-summary';
import { ForkOrigin } from './fork-origin';
import { Composer, type ComposerHandle, type ComposerSettings } from './composer';
import { HistoryDrawer } from './history-drawer';
import { lastPresetTemplate } from './preset-memory';
import { AssistantMessage, UserMessage } from './message-view';
import { INITIAL_STEPS, LIBRARY_TOOL_NAME, type UiMessage } from './types';

const SETTINGS_KEY = 'thinkflow-composer';

/** The cards of the home screen are document modes: `kind` picks the template list, `starter` the first words. */
export const SUGGESTIONS: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  kind: TemplateKind;
  starter: string;
}[] = [
  {
    icon: Lightbulb,
    title: 'Resumir um',
    subtitle: 'documento técnico',
    kind: 'summary',
    starter: 'Quero resumir o documento ',
  },
  {
    icon: FileText,
    title: 'Criar um PRD',
    subtitle: 'para nova funcionalidade',
    kind: 'prd',
    starter: 'Quero um PRD para ',
  },
  {
    icon: ChartColumn,
    title: 'Gerar um relatório',
    subtitle: 'de dados',
    kind: 'report',
    starter: 'Quero gerar um relatório sobre ',
  },
  {
    icon: Image,
    title: 'Criar um protótipo',
    subtitle: 'de interface',
    kind: 'prototype',
    starter: 'Quero um protótipo de ',
  },
];

const ALL_TEMPLATES_KEY = [...keys.reportTemplates, 'list', 'all'] as const;

function loadSettings(): Partial<ComposerSettings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<ComposerSettings>;
  } catch {
    return {};
  }
}

function saveSettings(settings: ComposerSettings) {
  try {
    // the library and the document mode belong to the conversation: new ones start without them
    const { libraryId: _libraryId, preset: _preset, ...persisted } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  } catch {
    // ignore
  }
}

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const conversationId = searchParams.get('c');
  const { data: auth } = useAuthStatus();
  const { data: models = [] } = useModelOptions();
  const { data: appSettings } = useSettings();
  const { data: libraries } = useLibraries();
  const queryClient = useQueryClient();

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [summary, setSummary] = useState<ConversationSummaryDto | null>(null);
  const [origin, setOrigin] = useState<{ id: string; title: string | null } | null>(null);
  const [settings, setSettings] = useState<ComposerSettings>(() => ({
    mode: 'chat',
    model: '',
    useMcp: true,
    permissionMode: 'plan',
    cwd: '',
    ...loadSettings(),
    libraryId: null,
    preset: null,
  }));
  const [generating, setGenerating] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const ownConversationRef = useRef<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // pick a default model once options load
  useEffect(() => {
    if (models.length === 0) return;
    if (!settings.model || !models.some((m) => m.id === settings.model)) {
      setSettings((s) => ({ ...s, model: models[0]!.id }));
    }
  }, [models, settings.model]);

  useEffect(() => saveSettings(settings), [settings]);

  // a deleted library cannot stay selected
  useEffect(() => {
    if (libraries && settings.libraryId && !libraries.some((l) => l.id === settings.libraryId))
      setSettings((s) => ({ ...s, libraryId: null }));
  }, [libraries, settings.libraryId]);

  // load a conversation when the URL changes (but not the one we are streaming into)
  useEffect(() => {
    if (!conversationId) {
      if (!ownConversationRef.current) {
        setMessages([]);
        setSummary(null);
        setOrigin(null);
      }
      return;
    }
    if (conversationId === ownConversationRef.current) return;
    let cancelled = false;
    api
      .get<ConversationDetailDto>(`/api/conversations/${conversationId}`)
      .then((detail) => {
        if (cancelled) return;
        // "Dados com IA" conversations live on their own page
        if (detail.mode === 'data') {
          navigate(`/dados?c=${encodeURIComponent(detail.id)}`, { replace: true });
          return;
        }
        setMessages(detail.messages.map(fromDto));
        setSummary(detail.summary ?? null);
        setOrigin(
          detail.parentConversationId
            ? { id: detail.parentConversationId, title: detail.parentTitle ?? null }
            : null,
        );
        setSettings((s) => ({
          ...s,
          mode: detail.mode,
          model: detail.model || s.model,
          libraryId: detail.libraryId ?? null,
          preset: detail.preset ?? null,
          ...(detail.mode === 'agent' && detail.agent.permissionMode
            ? { permissionMode: detail.agent.permissionMode }
            : {}),
          ...(detail.mode === 'agent' && detail.agent.cwd ? { cwd: detail.agent.cwd } : {}),
        }));
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

  const send = async (text: string, attachments: ChatAttachment[]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      {
        id: `local-user-${Date.now()}`,
        role: 'user',
        content: text,
        toolCalls: [],
        attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })),
      },
      {
        id: `local-assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        toolCalls: [],
        steps: { ...INITIAL_STEPS },
        streaming: true,
      },
    ]);

    let summaryChanged = false;
    try {
      await streamChat(
        {
          ...(conversationId ? { conversationId } : {}),
          mode: settings.mode,
          model: settings.model,
          content: text,
          attachments,
          useMcp: settings.useMcp,
          ...(settings.mode === 'chat'
            ? { libraryId: settings.libraryId, preset: settings.preset }
            : {}),
          ...(settings.mode === 'agent'
            ? {
                agent: {
                  permissionMode: settings.permissionMode,
                  ...(settings.cwd ? { cwd: settings.cwd } : {}),
                },
              }
            : {}),
        },
        (event) => {
          if (event.type === 'conversation') {
            ownConversationRef.current = event.conversationId;
            if (event.conversationId !== conversationId)
              setSearchParams({ c: event.conversationId }, { replace: true });
            return;
          }
          if (event.type === 'context' && event.omittedMessages > 0) summaryChanged = true;
          updateLast((m) => {
            const next = applyStreamEvent(m, event);
            const used = libraries?.find((l) => l.id === settings.libraryId);
            return event.type === 'tool_call' && event.name === LIBRARY_TOOL_NAME && used
              ? { ...next, library: { id: used.id, name: used.name } }
              : next;
          });
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
        ...(controller.signal.aborted && !m.error ? { error: 'Geração interrompida' } : {}),
      }));
      setStreaming(false);
      abortRef.current = null;
      const id = ownConversationRef.current;
      if (summaryChanged && id) {
        api
          .get<ConversationDetailDto>(`/api/conversations/${id}`)
          .then((detail) => setSummary(detail.summary ?? null))
          .catch(() => undefined);
      }
      void queryClient.invalidateQueries({ queryKey: keys.conversations });
    }
  };

  const newConversation = () => {
    abortRef.current?.abort();
    ownConversationRef.current = null;
    setMessages([]);
    setSummary(null);
    setOrigin(null);
    setSettings((s) => ({ ...s, libraryId: null, preset: null }));
    setSearchParams({}, { replace: false });
  };

  const selectConversation = (id: string | null) => {
    abortRef.current?.abort();
    ownConversationRef.current = null;
    setSummary(null);
    setOrigin(null);
    if (id) setSearchParams({ c: id });
    else newConversation();
  };

  const fork = async (messageId: string) => {
    if (!conversationId) return;
    try {
      const created = await api.post<ConversationDto>(`/api/conversations/${conversationId}/fork`, {
        messageId,
      });
      notify.success('Conversa derivada — o contexto anterior foi resumido');
      void queryClient.invalidateQueries({ queryKey: keys.conversations });
      selectConversation(created.id);
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  /** Home cards: switch to chat mode with the document template and offer the first words. */
  const startPreset = async (kind: TemplateKind, starter: string) => {
    let templates: ReportTemplateSummaryDto[] = [];
    try {
      const all = await queryClient.fetchQuery({
        queryKey: ALL_TEMPLATES_KEY,
        queryFn: () => api.get<ReportTemplateSummaryDto[]>('/api/report-templates'),
        staleTime: 30_000,
      });
      templates = Array.isArray(all) ? all.filter((t) => t.kind === kind) : [];
    } catch (err) {
      notify.error(errorMessage(err));
    }
    const remembered = lastPresetTemplate(kind);
    const chosen = templates.find((t) => t.id === remembered) ?? templates[0];
    if (chosen) {
      setSettings((s) => ({ ...s, mode: 'chat', preset: { kind, templateId: chosen.id } }));
    } else {
      notify.warning('Não há modelos desse tipo. Crie um em Relatórios > Modelos.');
    }
    composerRef.current?.fill(starter);
  };

  /** "Gerar agora": the server reads the answers from the conversation and starts the job. */
  const generateNow = async () => {
    const { preset } = settings;
    if (!conversationId || !preset || generating) return;
    setGenerating(true);
    try {
      const report = await api.post<ReportDto>('/api/reports', {
        templateId: preset.templateId,
        model: settings.model,
        conversationId,
        libraryId: settings.libraryId,
        ...(settings.useMcp ? {} : { useMcp: false }),
      });
      notify.success(`Geração iniciada: ${report.title}`);
      setMessages((prev) => [
        ...prev,
        {
          id: `local-report-${report.id}`,
          role: 'assistant',
          content: '',
          toolCalls: [],
          report: { id: report.id, title: report.title, kind: report.kind },
        },
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'report_missing_variables') {
        const missing = err.message.replace(/^[^:]*:\s*/, '').replace(/\.$/, '');
        notify.warning(`Responda primeiro: ${missing}`);
      } else {
        notify.error(errorMessage(err));
      }
    } finally {
      setGenerating(false);
    }
  };

  const setFeedback = (id: string, value: 'up' | 'down' | null) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, feedback: value } : m)));

  const name = auth?.user?.name ? firstName(auth.user.name) : '';
  const empty = messages.length === 0;
  const omitted = [...messages].reverse().find((m) => m.context)?.context?.omittedMessages ?? 0;

  return (
    <div className="relative flex h-full flex-col">
      <div className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-80" aria-hidden />

      <div className="relative flex items-center justify-end gap-2 px-4 pt-4 sm:px-8">
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History className="h-4 w-4" /> Histórico
        </Button>
        {!empty && (
          <Button variant="secondary" size="sm" onClick={newConversation}>
            <Plus className="h-4 w-4" /> Nova conversa
          </Button>
        )}
      </div>

      <div className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-6">
          {empty && (
            <section className="pt-6 sm:pt-12">
              <div className="flex items-center gap-5 sm:gap-7">
                <LogoMark className="h-16 w-16 shrink-0 sm:h-24 sm:w-24" />
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
                    Olá{name ? ', ' : ''}
                    <span className="bg-gradient-to-r from-violet-500 to-purple-400 bg-clip-text text-transparent">
                      {name || ''}
                    </span>
                    !
                  </h1>
                  <p className="mt-2 text-lg text-muted sm:text-2xl">Como posso te ajudar hoje?</p>
                </div>
              </div>
              <div className="mt-8 grid grid-cols-1 gap-3 sm:mt-12 sm:grid-cols-2 xl:grid-cols-4">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    onClick={() => void startPreset(s.kind, s.starter)}
                    className="flex cursor-pointer items-center gap-4 rounded-2xl border border-border bg-surface/80 px-5 py-5 text-left transition-colors hover:border-border-strong hover:bg-surface-hover"
                  >
                    <s.icon
                      className="h-7 w-7 shrink-0 text-accent-text"
                      strokeWidth={1.6}
                      aria-hidden
                    />
                    <span className="text-[15px] leading-snug">
                      {s.title}
                      <br />
                      <span className="text-muted">{s.subtitle}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {origin && (
            <ForkOrigin parentId={origin.id} parentTitle={origin.title} summary={summary} />
          )}
          {summary && !origin && <ContextSummary summary={summary} />}
          {messages.map((m) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                onFeedback={setFeedback}
                {...(conversationId && !streaming ? { onFork: (id: string) => void fork(id) } : {})}
              />
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="relative px-4 pt-2 pb-4 sm:px-8 sm:pb-6">
        <div className="mx-auto w-full max-w-5xl">
          {omitted > 0 && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-subtle" role="status">
              <ScrollText className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Mensagens antigas resumidas para caber no contexto
            </p>
          )}
          <Composer
            ref={composerRef}
            settings={settings}
            onSettingsChange={setSettings}
            models={models}
            libraries={libraries ?? []}
            streaming={streaming}
            onSend={(text, attachments) => void send(text, attachments)}
            onStop={() => abortRef.current?.abort()}
            hasConversation={!!conversationId}
            generating={generating}
            onGenerateNow={() => void generateNow()}
            privacyEnabled={appSettings?.privacy?.enabled !== false}
          />
          {settings.mode === 'agent' && !settings.cwd && appSettings?.agentDefaultCwd && (
            <p className="mt-1.5 text-xs text-subtle">
              Pasta de trabalho do agente: {appSettings.agentDefaultCwd}
            </p>
          )}
        </div>
      </div>

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        activeId={conversationId}
        onSelect={selectConversation}
      />
    </div>
  );
}
