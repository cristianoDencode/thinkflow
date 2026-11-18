import { useQueryClient } from '@tanstack/react-query';
import {
  generatedStepTitle,
  STEP_TITLE_MAX_CHARS,
  stepTitle,
  type TestSessionDto,
  type TestStep,
} from '@thinkflow/shared';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { keys } from '../../lib/queries';

const DEBOUNCE_MS = 800;

type Status = 'idle' | 'saving' | 'saved' | 'error';

/**
 * The step title as an inline editor: click to edit, auto-saves (debounced and on blur),
 * Enter saves, Esc cancels. Empty text goes back to the generated title.
 */
export function StepTitleEditor({
  session,
  step,
  index,
  editable,
}: {
  session: TestSessionDto;
  step: TestStep;
  index: number;
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const def = session.definition;
  const shown = stepTitle(def, step);
  const generated = generatedStepTitle(def, step);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shown);
  const [status, setStatus] = useState<Status>('idle');
  const [errorText, setErrorText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  const lastSent = useRef<string | null>(null);
  const url = `/api/tests/sessions/${session.id}/steps/${step.id}`;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (editing) {
      area.current?.focus();
      area.current?.select();
    }
  }, [editing]);

  const send = async (title: string | null) => {
    setStatus('saving');
    try {
      const result = await api.patch<TestSessionDto>(url, { title });
      lastSent.current = title;
      queryClient.setQueryData([...keys.tests, 'detail', session.id], result);
      void queryClient.invalidateQueries({ queryKey: keys.tests });
      setStatus('saved');
      return true;
    } catch (err) {
      setErrorText(errorMessage(err));
      setStatus('error');
      return false;
    }
  };

  /** Value to store for a text: null when it is blank or equals the generated title. */
  const toStored = (text: string) => {
    const t = text.trim();
    return !t || t === generated ? null : t;
  };
  const save = (text: string) => {
    clearTimeout(timer.current);
    const next = toStored(text);
    if (next === lastSent.current) return Promise.resolve(true);
    return send(next);
  };

  const start = () => {
    cancelled.current = false;
    lastSent.current = step.title?.trim() || null;
    setDraft(shown);
    setStatus('idle');
    setEditing(true);
  };
  const change = (text: string) => {
    setDraft(text);
    setStatus('idle');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(text), DEBOUNCE_MS);
  };
  const finish = async () => {
    if (cancelled.current) return;
    const ok = await save(draft);
    if (ok) setEditing(false);
  };
  const cancel = () => {
    cancelled.current = true;
    clearTimeout(timer.current);
    setStatus('idle');
    setEditing(false);
  };
  const restore = async () => {
    clearTimeout(timer.current);
    if (await send(null)) setEditing(false);
  };

  if (!editable) return <p className="mt-1 break-words text-sm">{shown}</p>;

  return (
    <div className="mt-1">
      {editing ? (
        <textarea
          ref={area}
          aria-label={`Título do passo ${index + 1}`}
          value={draft}
          rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 70)))}
          maxLength={STEP_TITLE_MAX_CHARS}
          className="w-full resize-none rounded-md border border-border bg-bg-elevated px-2 py-1 text-sm text-fg focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25"
          onChange={(e) => change(e.target.value)}
          onBlur={() => void finish()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void finish();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <button
          type="button"
          aria-label={`Editar título do passo ${index + 1}`}
          title="Clique para editar o título"
          className="block w-full cursor-text break-words rounded-md px-1 py-0.5 text-left text-sm hover:bg-accent-soft/60"
          onClick={start}
        >
          {shown}
        </button>
      )}
      <div
        className="flex flex-wrap items-center gap-2 px-1 text-xs text-subtle"
        aria-live="polite"
      >
        {status === 'saving' && <span>Salvando…</span>}
        {status === 'saved' && <span>Salvo</span>}
        {status === 'error' && (
          <span className="text-danger">
            {errorText || 'Não foi possível salvar'}{' '}
            <button
              type="button"
              className="underline"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void save(draft)}
            >
              Tentar de novo
            </button>
          </span>
        )}
        {step.title && (
          <button
            type="button"
            className="underline hover:text-fg"
            aria-label={`Restaurar título automático do passo ${index + 1}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void restore()}
          >
            Restaurar título automático
          </button>
        )}
      </div>
    </div>
  );
}
