import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  stepTitle,
  type PrototypeDetailDto,
  type PrototypeDto,
  type PrototypeRenderDto,
  type PrototypeSendInput,
  type PrototypeSendResultDto,
  type TestSessionDto,
} from '@thinkflow/shared';
import { Download, ExternalLink, ImageDown, Send } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { keys, useTestSession, useTestSessions } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { protoKeys } from './queries';

type Scale = 1 | 2;
type Target = 'end' | 'after' | 'replace';

const SCALE_OPTIONS: { value: Scale; label: string }[] = [
  { value: 1, label: 'Normal (1x)' },
  { value: 2, label: 'Nítida (2x, arquivo maior)' },
];

const renderUrl = (id: string, scale: Scale, force: boolean) => {
  const query = [scale === 2 ? 'scale=2' : '', force ? 'force=true' : ''].filter(Boolean).join('&');
  return `/api/prototypes/${id}/render${query ? `?${query}` : ''}`;
};

/** Renders the current version to PNG (the server reuses the last one while nothing changed). */
function useRenderPrototype(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { scale: Scale; force?: boolean }) =>
      api.post<PrototypeRenderDto>(renderUrl(id, input.scale, input.force ?? false)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: protoKeys.all });
    },
  });
}

const fileName = (name: string) =>
  `${
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'prototipo'
  }.png`;

/* ------------------------------ render + download ------------------------------ */

/**
 * "Gerar imagem": renders the prototype and shows the PNG with a "Baixar PNG" link. The editor
 * mounts it in its toolbar (`<RenderImageButton prototype={detail} />`).
 */
export function RenderImageButton({
  prototype,
  size = 'sm',
  variant = 'secondary',
}: {
  prototype: Pick<PrototypeDto, 'id' | 'name'>;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'outline' | 'soft' | 'ghost';
}) {
  const render = useRenderPrototype(prototype.id);
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState<Scale>(1);
  const [error, setError] = useState<string | null>(null);
  const scaleId = useId();

  const run = async (next: Scale, force: boolean) => {
    setError(null);
    try {
      await render.mutateAsync({ scale: next, force });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const result = render.data;

  return (
    <>
      <Button
        size={size}
        variant={variant}
        loading={render.isPending && !open}
        onClick={() => {
          setOpen(true);
          void run(scale, false);
        }}
      >
        <ImageDown className="h-4 w-4" aria-hidden />
        Gerar imagem
      </Button>
      {open && (
        <Dialog
          open
          size="lg"
          onClose={() => setOpen(false)}
          title="Imagem do protótipo"
          description="PNG da versão atual, no tamanho do protótipo. Gerado sem rede nem JavaScript: imagens externas não aparecem."
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Fechar
              </Button>
              <Button
                variant="outline"
                loading={render.isPending}
                onClick={() => void run(scale, true)}
              >
                Gerar novamente
              </Button>
              {result && !error && (
                <a
                  href={result.thumbnailUrl}
                  download={fileName(prototype.name)}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm hover:bg-accent-hover"
                >
                  <Download className="h-4 w-4" aria-hidden />
                  Baixar PNG
                </a>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field label="Qualidade" htmlFor={scaleId}>
              <Select
                id={scaleId}
                value={scale}
                onChange={(e) => {
                  const next: Scale = Number(e.target.value) === 2 ? 2 : 1;
                  setScale(next);
                  void run(next, false);
                }}
              >
                {SCALE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            {render.isPending && (
              <p role="status" className="text-sm text-muted">
                Gerando a imagem…
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            {result && !render.isPending && !error && (
              <>
                <p className="text-xs text-muted">
                  {result.width} × {result.height} px
                  {result.cached ? ' · imagem já gerada para esta versão' : ''}
                </p>
                {!!result.blockedRequests && (
                  <p role="status" className="text-xs text-warning">
                    {result.blockedRequests === 1
                      ? '1 recurso externo foi bloqueado'
                      : `${result.blockedRequests} recursos externos foram bloqueados`}{' '}
                    (a imagem é gerada sem acesso à rede; use imagens embutidas).
                  </p>
                )}
                <img
                  src={result.thumbnailUrl}
                  alt={`Imagem de ${prototype.name}`}
                  className="max-h-[50vh] w-full rounded-lg border border-border bg-white object-contain object-top"
                />
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

/* ------------------------------ send to the document ------------------------------ */

function useSendToSession(prototypeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PrototypeSendInput) =>
      api.post<PrototypeSendResultDto>(`/api/prototypes/${prototypeId}/send-to-session`, input),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: protoKeys.all }),
        queryClient.invalidateQueries({ queryKey: keys.tests }),
      ]);
      return result;
    },
  });
}

type Phase = 'idle' | 'render' | 'send';

/** The steps of the chosen session, as a radio list: number, title and the current print. */
function StepPicker({
  session,
  value,
  onChange,
  label,
}: {
  session: TestSessionDto;
  value: string;
  onChange(stepId: string): void;
  label: string;
}) {
  const steps = session.definition.steps;
  if (steps.length === 0) {
    return <p className="text-sm text-muted">Esta sessão ainda não tem passos.</p>;
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1"
    >
      {steps.map((step, index) => {
        const title = stepTitle(session.definition, step);
        const image = session.images[step.id];
        const selected = value === step.id;
        return (
          <label
            key={step.id}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover',
              selected && 'bg-accent/15',
            )}
          >
            <input
              type="radio"
              name="send-step"
              className="sr-only"
              checked={selected}
              onChange={() => onChange(step.id)}
              aria-label={`Passo ${index + 1}: ${title}`}
            />
            <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">
              {index + 1}
            </span>
            {image ? (
              <img
                src={image.imageUrl}
                alt=""
                loading="lazy"
                className="h-9 w-14 shrink-0 rounded border border-border object-cover object-top"
              />
            ) : (
              <span className="h-9 w-14 shrink-0 rounded border border-dashed border-border" />
            )}
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {image && image.annotations.length > 0 && (
              <span className="shrink-0 text-xs text-muted">com marcações</span>
            )}
          </label>
        );
      })}
    </div>
  );
}

/**
 * "Enviar para o documento": renders the prototype and puts the PNG in a test session, as a new
 * step or as the image of an existing one. Mount it conditionally; `onDone` runs when it closes
 * (with the result when something was sent).
 */
export function SendToDocumentDialog({
  prototype,
  onDone,
}: {
  prototype: PrototypeDetailDto | PrototypeDto;
  onDone?: (result?: PrototypeSendResultDto) => void;
}) {
  const sessions = useTestSessions();
  const renderMutation = useRenderPrototype(prototype.id);
  const send = useSendToSession(prototype.id);

  const [sessionId, setSessionId] = useState(prototype.sessionId ?? '');
  const [target, setTarget] = useState<Target>('end');
  const [stepId, setStepId] = useState('');
  const [title, setTitle] = useState('');
  const [include, setInclude] = useState(true);
  const [includeTouched, setIncludeTouched] = useState(false);
  const [scale, setScale] = useState<Scale>(1);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PrototypeSendResultDto | null>(null);

  const sessionQuery = useTestSession(sessionId || undefined);
  const session = sessionQuery.data;
  const list = useMemo(() => sessions.data ?? [], [sessions.data]);
  const chosen = list.find((s) => s.id === sessionId);
  const busy = chosen ? chosen.state !== 'idle' : false;

  const stepNeeded = target !== 'end';
  const pickedImage = stepId && session ? session.images[stepId] : undefined;
  const needsConfirm = target === 'replace' && !!pickedImage && pickedImage.annotated;
  const defaultTitle = `Protótipo: ${prototype.name}`;

  const canSend =
    phase === 'idle' &&
    !!sessionId &&
    !busy &&
    (!stepNeeded || (!!stepId && !!session?.definition.steps.some((s) => s.id === stepId))) &&
    (!needsConfirm || confirmed);

  const close = () => onDone?.(result ?? undefined);

  const submit = async () => {
    setError(null);
    try {
      setPhase('render');
      await renderMutation.mutateAsync({ scale });
      setPhase('send');
      const body: PrototypeSendInput = {
        sessionId,
        target: target === 'replace' ? 'replaceStepImage' : 'newStep',
        scale,
        ...(target === 'after' ? { afterStepId: stepId } : {}),
        ...(target === 'replace' ? { stepId } : {}),
        ...(target !== 'replace' && title.trim() ? { title: title.trim() } : {}),
        // replacing keeps the step's own choice unless the person flipped the switch
        ...(target !== 'replace' || includeTouched ? { include } : {}),
      };
      setResult(await send.mutateAsync(body));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPhase('idle');
    }
  };

  const targetOptions: { value: Target; label: string }[] = [
    { value: 'end', label: 'Novo passo no final da sessão' },
    { value: 'after', label: 'Novo passo depois de um passo' },
    { value: 'replace', label: 'Substituir a imagem de um passo' },
  ];

  const sessionFieldId = useId();
  const titleFieldId = useId();
  const scaleFieldId = useId();

  return (
    <Dialog
      open
      size="lg"
      onClose={close}
      title="Enviar para o documento"
      description="Gera a imagem do protótipo e a coloca na sessão de teste, para anotar em Passos e sair no Caso de Teste."
      footer={
        result ? (
          <Button onClick={close}>Concluir</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={phase !== 'idle'}>
              Cancelar
            </Button>
            <Button loading={phase !== 'idle'} disabled={!canSend} onClick={() => void submit()}>
              <Send className="h-4 w-4" aria-hidden />
              {phase === 'render'
                ? 'Gerando imagem…'
                : phase === 'send'
                  ? 'Enviando…'
                  : 'Gerar imagem e enviar'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3" role="status">
          <p className="text-sm text-fg">
            {result.target === 'newStep'
              ? 'Imagem enviada como um novo passo do documento.'
              : 'Imagem do passo substituída.'}
          </p>
          <img
            src={result.render.thumbnailUrl}
            alt={`Imagem de ${prototype.name}`}
            className="max-h-56 w-full rounded-lg border border-border bg-white object-contain object-top"
          />
          <Link
            to={`/tests/${result.sessionId}#step-${result.stepId}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            Abrir em Passos
          </Link>
          {!!result.render.blockedRequests && (
            <p className="text-xs text-warning">
              {result.render.blockedRequests} recurso(s) externo(s) foram bloqueados na imagem.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field
            label="Sessão de teste"
            htmlFor={sessionFieldId}
            hint={
              busy
                ? 'Esta sessão está gravando ou executando. Pare antes de enviar.'
                : prototype.sessionId && sessionId === prototype.sessionId
                  ? 'Sessão vinculada ao protótipo.'
                  : undefined
            }
          >
            <Select
              id={sessionFieldId}
              value={sessionId}
              onChange={(e) => {
                setSessionId(e.target.value);
                setStepId('');
                setConfirmed(false);
              }}
            >
              <option value="">Escolha a sessão…</option>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.state !== 'idle' ? ' (em uso)' : ''}
                </option>
              ))}
            </Select>
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg">Onde colocar</legend>
            {targetOptions.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="send-target"
                  checked={target === o.value}
                  onChange={() => {
                    setTarget(o.value);
                    setStepId('');
                    setConfirmed(false);
                  }}
                />
                {o.label}
              </label>
            ))}
          </fieldset>

          {stepNeeded && sessionId && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-fg">
                {target === 'after' ? 'Depois de qual passo?' : 'Qual passo?'}
              </span>
              {sessionQuery.isLoading || !session ? (
                <p className="text-sm text-muted">Carregando passos…</p>
              ) : (
                <StepPicker
                  session={session}
                  value={stepId}
                  onChange={(id) => {
                    setStepId(id);
                    setConfirmed(false);
                  }}
                  label={target === 'after' ? 'Passo anterior' : 'Passo a substituir'}
                />
              )}
            </div>
          )}

          {needsConfirm && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                As marcações e o recorte do print atual serão descartados. Confirmo a substituição.
              </span>
            </label>
          )}

          {target !== 'replace' && (
            <Field label="Título do passo" htmlFor={titleFieldId}>
              <Input
                id={titleFieldId}
                value={title}
                maxLength={300}
                placeholder={defaultTitle}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-fg">Mostrar no documento</span>
              <span className="text-xs text-muted">
                {target === 'replace' && !includeTouched
                  ? 'Mantém a escolha atual do passo.'
                  : 'A imagem entra no Caso de Teste.'}
              </span>
            </div>
            <Switch
              checked={include}
              label="Mostrar a imagem no documento"
              onChange={(value) => {
                setInclude(value);
                setIncludeTouched(true);
              }}
            />
          </div>

          <Field label="Qualidade da imagem" htmlFor={scaleFieldId}>
            <Select
              id={scaleFieldId}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value) === 2 ? 2 : 1)}
            >
              {SCALE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {phase !== 'idle' && (
            <p role="status" className="text-sm text-muted">
              {phase === 'render' ? 'Gerando a imagem…' : 'Enviando para o documento…'}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
