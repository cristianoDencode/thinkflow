import { notify } from '../../lib/notify';
import type {
  AgentPermission,
  ChatAttachment,
  ChatMode,
  ChatPreset,
  LibraryDto,
  ModelOptionDto,
} from '@thinkflow/shared';
import {
  Bot,
  Library,
  MessageSquareText,
  Paperclip,
  Plug,
  SendHorizontal,
  Square,
  X,
} from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { cn } from '../../lib/utils';
import { PresetControls } from './preset-controls';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXT =
  /\.(txt|md|markdown|json|csv|tsv|xml|yaml|yml|log|sql|ts|tsx|js|jsx|py|java|cs|go|rs|rb|php|html|css|sh|ps1|ini|toml|env)$/i;

export interface ComposerSettings {
  mode: ChatMode;
  model: string;
  useMcp: boolean;
  permissionMode: AgentPermission;
  cwd: string;
  /** Library connected to the conversation (chat mode only); null = none. */
  libraryId: string | null;
  /** Document-template mode of the conversation (chat mode only); null = plain chat. */
  preset: ChatPreset | null;
}

export interface ComposerHandle {
  fill(text: string): void;
}

const PERMISSIONS: { value: AgentPermission; label: string }[] = [
  { value: 'plan', label: 'Plan (somente planejar)' },
  { value: 'default', label: 'Somente leitura' },
  { value: 'acceptEdits', label: 'Aceitar edições' },
  { value: 'bypassPermissions', label: 'Tudo liberado (cuidado)' },
];

export const Composer = forwardRef<
  ComposerHandle,
  {
    settings: ComposerSettings;
    onSettingsChange(settings: ComposerSettings): void;
    models: ModelOptionDto[];
    libraries?: LibraryDto[];
    streaming: boolean;
    onSend(text: string, attachments: ChatAttachment[]): void;
    onStop(): void;
    /** "Gerar agora" needs a stored conversation to read the answers from. */
    hasConversation?: boolean;
    generating?: boolean;
    onGenerateNow?(): void;
    /** The privacy firewall is on: images still go out unfiltered, so warn about them. */
    privacyEnabled?: boolean;
  }
>(function Composer(
  {
    settings,
    onSettingsChange,
    models,
    libraries = [],
    streaming,
    onSend,
    onStop,
    hasConversation = false,
    generating = false,
    onGenerateNow,
    privacyEnabled = false,
  },
  ref,
) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    fill(value: string) {
      setText(value);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(value.length, value.length);
        autosize(el);
      });
    },
  }));

  const set = <K extends keyof ComposerSettings>(key: K, value: ComposerSettings[K]) =>
    onSettingsChange({ ...settings, [key]: value });

  const submit = () => {
    const value = text.trim();
    if (!value || streaming) return;
    if (!settings.model) {
      notify.error('Selecione um modelo ou combo antes de enviar');
      return;
    }
    onSend(value, attachments);
    setText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = '';
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const added: ChatAttachment[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        notify.error(`${file.name}: arquivo maior que 5 MB`);
        continue;
      }
      const isImage = file.type.startsWith('image/');
      const isText =
        file.type.startsWith('text/') ||
        TEXT_EXT.test(file.name) ||
        file.type === 'application/json';
      if (!isImage && !isText) {
        notify.error(`${file.name}: envie imagens ou arquivos de texto`);
        continue;
      }
      const data = isImage ? await readAsDataUrl(file) : await file.text();
      added.push({ name: file.name, mimeType: file.type || 'text/plain', data });
    }
    setAttachments((prev) => [...prev, ...added].slice(0, 10));
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-2xl border-2 border-accent/60 bg-surface shadow-lg shadow-accent/10 transition-colors focus-within:border-accent">
        {privacyEnabled && attachments.some((a) => a.mimeType.startsWith('image/')) && (
          <p
            role="status"
            className="mx-3 mt-3 rounded-lg bg-warning-soft px-2.5 py-1.5 text-xs text-warning"
          >
            Imagens são enviadas sem filtro de dados pessoais.
          </p>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a, i) => (
              <span
                key={`${a.name}-${i}`}
                className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 text-xs"
              >
                <Paperclip className="h-3 w-3" />
                {a.name}
                <button
                  type="button"
                  className="cursor-pointer text-muted hover:text-fg"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remover ${a.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 p-2.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void addFiles(e.target.files)}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fileRef.current?.click()}
            aria-label="Anexar arquivo"
            title="Anexar arquivo"
          >
            <Paperclip className="h-5 w-5" />
          </Button>
          <label htmlFor="prompt" className="sr-only">
            Pergunta
          </label>
          <textarea
            id="prompt"
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              settings.mode === 'agent'
                ? 'Descreva a tarefa para o agente…'
                : 'Digite sua pergunta aqui…'
            }
            className="scrollbar-thin max-h-60 min-h-10 flex-1 resize-none bg-transparent py-2 text-[15px] placeholder:text-subtle focus:outline-none"
          />
          {streaming ? (
            <Button
              size="icon"
              variant="secondary"
              onClick={onStop}
              aria-label="Parar geração"
              className="h-10 w-12 rounded-xl"
            >
              <Square className="h-4 w-4 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={!text.trim()}
              aria-label="Enviar"
              className="h-10 w-12 rounded-xl"
            >
              <SendHorizontal className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div
          className="inline-flex rounded-xl border border-border bg-surface p-0.5"
          role="radiogroup"
          aria-label="Modo"
        >
          {(
            [
              { value: 'chat', label: 'Chat', icon: MessageSquareText },
              { value: 'agent', label: 'Agente', icon: Bot },
            ] as const
          ).map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={settings.mode === m.value}
              onClick={() => set('mode', m.value)}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium',
                settings.mode === m.value
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-muted hover:text-fg',
              )}
              title={
                m.value === 'agent'
                  ? 'Usa o Claude Code (Agent SDK) com tokens roteados pelo Thinkflow'
                  : 'Chat direto via roteador'
              }
            >
              <m.icon className="h-3.5 w-3.5" /> {m.label}
            </button>
          ))}
        </div>

        {models.length > 0 ? (
          <Select
            aria-label="Modelo"
            value={settings.model}
            onChange={(e) => set('model', e.target.value)}
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
            Cadastre uma conexão para escolher um modelo
          </Link>
        )}

        <button
          type="button"
          onClick={() => set('useMcp', !settings.useMcp)}
          aria-pressed={settings.useMcp}
          className={cn(
            'flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium',
            settings.useMcp
              ? 'border-transparent bg-accent-soft text-accent-text'
              : 'border-border text-muted',
          )}
          title="Disponibilizar as ferramentas dos servidores MCP ativos"
        >
          <Plug className="h-3.5 w-3.5" /> MCP {settings.useMcp ? 'ligado' : 'desligado'}
        </button>

        <span className="inline-flex items-center gap-1">
          <Library
            className={cn('h-3.5 w-3.5', settings.libraryId ? 'text-accent-text' : 'text-muted')}
            aria-hidden
          />
          <Select
            aria-label="Biblioteca"
            value={settings.libraryId ?? ''}
            onChange={(e) => set('libraryId', e.target.value || null)}
            disabled={settings.mode === 'agent'}
            title={
              settings.mode === 'agent'
                ? 'Disponível no modo Chat'
                : 'Conectar uma biblioteca de documentos: a IA consulta só os trechos relevantes'
            }
            className="h-8 w-auto max-w-56 rounded-lg py-0 text-xs"
          >
            <option value="">Biblioteca: nenhuma</option>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                Biblioteca: {l.name}
                {l.documentCount > 0 && l.readyCount === 0 ? ' (processando…)' : ''}
              </option>
            ))}
          </Select>
        </span>

        {settings.mode === 'chat' && settings.preset && (
          <PresetControls
            preset={settings.preset}
            onChange={(preset) => set('preset', preset)}
            canGenerate={hasConversation && !streaming}
            generating={generating}
            onGenerate={() => onGenerateNow?.()}
          />
        )}

        {settings.mode === 'agent' && (
          <>
            <Select
              aria-label="Permissões do agente"
              value={settings.permissionMode}
              onChange={(e) => set('permissionMode', e.target.value as AgentPermission)}
              className="h-8 w-auto rounded-lg py-0 text-xs"
            >
              {PERMISSIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Pasta de trabalho do agente"
              placeholder="Pasta de trabalho (padrão das configurações)"
              value={settings.cwd}
              onChange={(e) => set('cwd', e.target.value)}
              className="h-8 w-full rounded-lg text-xs sm:w-72"
            />
          </>
        )}
        <span className="ml-auto hidden text-xs text-subtle md:inline">
          Enter envia · Shift+Enter quebra linha
        </span>
      </div>
      {settings.mode === 'agent' && settings.preset && (
        <p className="text-xs text-subtle">Modos de documento funcionam no modo Chat.</p>
      )}
      {settings.mode === 'agent' ? (
        <p className="text-xs text-subtle">A biblioteca está disponível apenas no modo Chat.</p>
      ) : (
        settings.libraryId &&
        models.find((m) => m.id === settings.model)?.toolCalling === false && (
          <p className="text-xs text-warning" role="status">
            Este modelo pode não suportar ferramentas; a biblioteca pode não ser consultada.
          </p>
        )
      )}
    </div>
  );
});

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
