import { Play, SendHorizontal, Square } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type { ComposerHandle } from '../chat/composer';
import { looksLikeSql } from './query-utils';

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}

/**
 * Composer of "Dados com IA": Enter asks the AI (it explores and runs read-only SQL), Ctrl+Enter
 * runs the typed text as SQL directly, without the AI.
 */
export const DataComposer = forwardRef<
  ComposerHandle,
  {
    streaming: boolean;
    /** Why asking/running is not possible right now (no connection, no model…). */
    disabledReason?: { ask?: string; run?: string };
    onAsk(text: string): void;
    onRunSql(text: string): void;
    onStop(): void;
  }
>(function DataComposer({ streaming, disabledReason, onAsk, onRunSql, onStop }, ref) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const value = text.trim();
  const sqlLike = looksLikeSql(value);

  const reset = () => {
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = '';
  };

  const ask = () => {
    if (!value || streaming || disabledReason?.ask) return;
    onAsk(value);
    reset();
  };

  const run = () => {
    if (!value || streaming || disabledReason?.run) return;
    onRunSql(value);
    reset();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      run();
    } else if (!e.shiftKey) {
      e.preventDefault();
      ask();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-2xl border-2 border-accent/60 bg-surface shadow-lg shadow-accent/10 transition-colors focus-within:border-accent">
        <div className="flex flex-col gap-2 p-2.5">
          <label htmlFor="data-prompt" className="sr-only">
            Pergunta ou SQL
          </label>
          <textarea
            id="data-prompt"
            ref={textareaRef}
            rows={2}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={onKeyDown}
            placeholder="Pergunte em português ou cole uma SQL (SELECT…)"
            spellCheck={!sqlLike}
            className={cn(
              'scrollbar-thin max-h-60 min-h-12 w-full resize-none bg-transparent px-1.5 py-1.5 text-[15px] placeholder:text-subtle focus:outline-none',
              sqlLike && 'font-mono text-sm',
            )}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {sqlLike && !streaming && (
              <span className="mr-auto text-xs text-accent-text" role="status">
                Ctrl+Enter executa direto
              </span>
            )}
            {streaming ? (
              <Button variant="secondary" onClick={onStop} aria-label="Parar geração">
                <Square className="h-4 w-4 fill-current" /> Parar
              </Button>
            ) : (
              <>
                <Button
                  variant="soft"
                  onClick={run}
                  disabled={!value || !!disabledReason?.run}
                  title={disabledReason?.run ?? 'Executa o texto como SQL, sem a IA (Ctrl+Enter)'}
                >
                  <Play className="h-4 w-4" aria-hidden /> Executar SQL
                </Button>
                <Button
                  onClick={ask}
                  disabled={!value || !!disabledReason?.ask}
                  title={disabledReason?.ask ?? 'Pergunta para a IA (Enter)'}
                >
                  <SendHorizontal className="h-4 w-4" aria-hidden /> Perguntar
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      <p className="hidden text-xs text-subtle md:block">
        Enter pergunta à IA · Ctrl+Enter executa como SQL · Shift+Enter quebra linha · tudo é
        somente leitura
      </p>
    </div>
  );
});
