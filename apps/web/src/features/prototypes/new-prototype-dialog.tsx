import {
  ECIDADE_WINDOW_TEMPLATE_ID,
  PROTOTYPE_LIMITS,
  type PrototypeCreateInput,
  type PrototypeTemplateDto,
  type TestSessionSummaryDto,
} from '@thinkflow/shared';
import { LayoutTemplate } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCreatePrototype, useTemplates } from './queries';
import { prepareSnapshot } from './sanitize';

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

type Mode = 'blank' | 'ecidade' | 'mine' | 'html';

/** Sizes offered for the e-Cidade window (the first is the default). */
const ECIDADE_SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

/** Preview of a template, with a placeholder until the server has rendered the PNG. */
function TemplateThumb({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2 text-subtle">
      {src && !failed ? (
        <img
          src={src}
          alt={`Prévia de ${name}`}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <LayoutTemplate className="h-6 w-6" aria-hidden />
      )}
    </span>
  );
}

const clamp = (value: string, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
};

export function NewPrototypeDialog({
  sessions,
  initialSessionId,
  initialTemplateId,
  onClose,
  onCreated,
}: {
  sessions: TestSessionSummaryDto[];
  initialSessionId?: string;
  /** Opens with this template chosen (a built-in `builtin:…` id or a user template). */
  initialTemplateId?: string;
  onClose(): void;
  onCreated(id: string): void;
}) {
  const create = useCreatePrototype();
  const { data: templates = [] } = useTemplates();
  const builtin = templates.find((t) => t.id === ECIDADE_WINDOW_TEMPLATE_ID);
  const mine = templates.filter((t) => !t.builtin);
  const startsWithMine = Boolean(
    initialTemplateId && initialTemplateId !== ECIDADE_WINDOW_TEMPLATE_ID,
  );
  const [templateId, setTemplateId] = useState(startsWithMine ? (initialTemplateId ?? '') : '');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>(
    startsWithMine ? 'mine' : initialTemplateId ? 'ecidade' : 'blank',
  );
  const [html, setHtml] = useState('');
  const [css, setCss] = useState('');
  const [width, setWidth] = useState(
    String(initialTemplateId && !startsWithMine ? ECIDADE_SIZES[0]!.width : DEFAULT_WIDTH),
  );
  const [height, setHeight] = useState(
    String(initialTemplateId && !startsWithMine ? ECIDADE_SIZES[0]!.height : DEFAULT_HEIGHT),
  );
  const [sessionId, setSessionId] = useState(initialSessionId ?? '');
  const [error, setError] = useState<string | null>(null);

  const chooseMode = (next: Mode) => {
    setMode(next);
    setError(null);
    if (next === 'blank') resize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    if (next === 'ecidade') resize(ECIDADE_SIZES[0]!.width, ECIDADE_SIZES[0]!.height);
    if (next === 'mine') {
      const first = mine.find((t) => t.id === templateId) ?? mine[0];
      if (first) chooseTemplate(first);
    }
  };
  const resize = (w: number, h: number) => {
    setWidth(String(w));
    setHeight(String(h));
  };
  const chooseTemplate = (t: PrototypeTemplateDto) => {
    setTemplateId(t.id);
    resize(t.width, t.height);
  };

  const submit = async () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) return setError('Informe o nome do protótipo.');
    if (mode === 'html' && !html.trim()) return setError('Cole o HTML da tela.');
    if (mode === 'mine' && !mine.some((t) => t.id === templateId)) {
      return setError('Escolha um dos seus modelos.');
    }
    const w = clamp(width, PROTOTYPE_LIMITS.minSize, PROTOTYPE_LIMITS.maxWidth, DEFAULT_WIDTH);
    const h = clamp(height, PROTOTYPE_LIMITS.minSize, PROTOTYPE_LIMITS.maxHeight, DEFAULT_HEIGHT);
    let input: PrototypeCreateInput;
    if (mode === 'ecidade' || mode === 'mine') {
      input = {
        name: trimmed,
        fromTemplateId: mode === 'ecidade' ? ECIDADE_WINDOW_TEMPLATE_ID : templateId,
        width: w,
        height: h,
        sessionId: sessionId || null,
      };
    } else {
      // pasted markup is untrusted: store it already inert
      const prepared =
        mode === 'html' ? prepareSnapshot(html, css) : { html: '<body></body>', css: '' };
      input = {
        name: trimmed,
        snapshot: { ...prepared, width: w, height: h },
        sessionId: sessionId || null,
      };
    }
    try {
      const created = await create.mutateAsync(input);
      onCreated(created.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Novo protótipo"
      description="Comece de uma tela em branco, da tela padrão do perfil e-Cidade, de um dos seus modelos ou cole o HTML de uma tela existente."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={create.isPending} onClick={() => void submit()}>
            Criar e abrir
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Nome" htmlFor="proto-name">
          <Input
            id="proto-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Consulta de empenho"
          />
        </Field>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <legend className="mb-1.5 font-medium">Ponto de partida</legend>
          {(
            [
              ['blank', 'Em branco'],
              ['ecidade', 'Tela de sistema — perfil e-Cidade'],
              ['mine', 'Meus modelos'],
              ['html', 'Colar HTML'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="proto-mode"
                checked={mode === value}
                onChange={() => chooseMode(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {mode === 'ecidade' && (
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="w-full sm:w-64">
              <TemplateThumb
                src={builtin?.thumbnailUrl ?? null}
                name="Tela de sistema — perfil e-Cidade"
              />
            </div>
            <div className="flex flex-1 flex-col gap-2 text-sm">
              <p className="text-muted">
                {builtin?.description ??
                  'Janela do perfil e-Cidade com a barra azul, a área da rotina, a barra de status e a barra de tarefas.'}{' '}
                Arraste os blocos da paleta e-Cidade para o grupo “Dados”.
              </p>
              <div role="group" aria-label="Tamanho da tela" className="flex gap-2">
                {ECIDADE_SIZES.map((size) => {
                  const active = width === String(size.width) && height === String(size.height);
                  return (
                    <Button
                      key={size.width}
                      type="button"
                      size="sm"
                      variant={active ? 'primary' : 'secondary'}
                      aria-pressed={active}
                      onClick={() => resize(size.width, size.height)}
                    >
                      {size.width} × {size.height}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {mode === 'mine' &&
          (mine.length === 0 ? (
            <p className="text-sm text-muted">
              Você ainda não tem modelos. Abra um protótipo e use “Salvar como modelo”.
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label="Meus modelos"
              className="grid grid-cols-2 gap-3 sm:grid-cols-3"
            >
              {mine.map((t) => (
                <label
                  key={t.id}
                  className={cn(
                    'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-2 text-sm',
                    templateId === t.id ? 'border-accent bg-accent/10' : 'border-border',
                  )}
                >
                  <TemplateThumb src={t.thumbnailUrl} name={t.name} />
                  <span className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="proto-template"
                      checked={templateId === t.id}
                      onChange={() => chooseTemplate(t)}
                    />
                    <span className="truncate">{t.name}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        {mode === 'html' && (
          <>
            <Field
              label="HTML"
              htmlFor="proto-html"
              hint="Scripts, eventos e frames são removidos automaticamente."
            >
              <Textarea
                id="proto-html"
                rows={7}
                className="font-mono text-xs"
                value={html}
                onChange={(e) => setHtml(e.target.value)}
              />
            </Field>
            <Field label="CSS (opcional)" htmlFor="proto-css">
              <Textarea
                id="proto-css"
                rows={4}
                className="font-mono text-xs"
                value={css}
                onChange={(e) => setCss(e.target.value)}
              />
            </Field>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Largura (px)" htmlFor="proto-width">
            <Input
              id="proto-width"
              type="number"
              min={PROTOTYPE_LIMITS.minSize}
              max={PROTOTYPE_LIMITS.maxWidth}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
          </Field>
          <Field label="Altura (px)" htmlFor="proto-height">
            <Input
              id="proto-height"
              type="number"
              min={PROTOTYPE_LIMITS.minSize}
              max={PROTOTYPE_LIMITS.maxHeight}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Teste vinculado (opcional)" htmlFor="proto-session">
          <Select
            id="proto-session"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          >
            <option value="">Nenhum</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
