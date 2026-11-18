import {
  CT_USE_CASE_STATUS_SUGGESTIONS,
  menuPathByStep,
  sessionMode,
  splitUseCases,
  stepHasCtContent,
  STEP_KIND_LABELS,
  useCaseDisplayTitle,
  type MenuPathSuggestion,
  type TestSessionDto,
  type TestStep,
  type TestStepImageDto,
  stepTitle,
} from '@thinkflow/shared';
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  ImagePlus,
  ListChecks,
  MessageSquarePlus,
  Pencil,
  PenLine,
  Route,
  SeparatorHorizontal,
  Trash2,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { Input, Switch, Textarea } from '../../components/ui/form';
import { api } from '../../lib/api';
import { notify } from '../../lib/notify';
import { cn } from '../../lib/utils';
import { AssertionFields } from './assertion-fields';
import { StepTitleEditor } from './step-title-editor';
import { StepThumbnail } from './step-thumbnail';
import { useScrollToHash } from './use-scroll-to-hash';
import { useStepsView, type StepsFilter, type StepsView } from './steps-view';
import { useSessionAction } from './use-session-action';

// Konva only loads when a print is opened (keeps it out of the main bundle)
const AnnotationEditor = lazy(() =>
  import('./annotation-editor').then((m) => ({ default: m.AnnotationEditor })),
);

const stepTone = (step: TestStep) =>
  step.kind === 'checkpoint'
    ? 'accent'
    : step.kind === 'assert'
      ? 'success'
      : step.kind === 'note'
        ? 'warning'
        : 'neutral';

function StepRow({
  session,
  step,
  index,
  editable,
  menuSuggestion,
  onEditImage,
}: {
  session: TestSessionDto;
  step: TestStep;
  index: number;
  editable: boolean;
  /** "Após a correção, acessa o menu: …" offered on the first click of a menu path. */
  menuSuggestion?: MenuPathSuggestion;
  onEditImage(): void;
}) {
  const def = session.definition;
  const { busy, run } = useSessionAction(session.id);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState(step.comment ?? '');
  const [isCode, setIsCode] = useState(step.commentIsCode ?? false);
  const [assertion, setAssertion] = useState(step.assertion);
  const url = `/api/tests/sessions/${session.id}/steps/${step.id}`;
  const image: TestStepImageDto | undefined = session.images[step.id];
  const imageUrl = image ? `/api/tests/sessions/${session.id}/evidences/${image.id}` : '';
  const ids = def.steps.map((s) => s.id);
  const files = session.stepDownloads[step.id] ?? [];

  const move = (delta: number) => void run('move', () => reorder(session, index, delta));
  const saveComment = async () => {
    const ok = await run('comment', () =>
      api.patch(url, {
        ...(step.kind === 'note' && !comment.trim() ? { comment: step.comment } : { comment }),
        commentIsCode: isCode,
        ...(step.kind === 'assert' && assertion ? { assertion } : {}),
      }),
    );
    if (ok) setEditing(false);
  };
  const useSuggestion = () =>
    void run('suggestion', () => api.patch(url, { comment: menuSuggestion!.text }));
  const startUseCase = () =>
    void run(
      'use-case',
      () =>
        api.post(`/api/tests/sessions/${session.id}/steps/use-cases`, { beforeStepId: step.id }),
      'Caso de uso criado antes deste passo',
    );

  return (
    <Card id={`step-${step.id}`} className="flex scroll-mt-4 gap-3 p-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stepTone(step)}>{STEP_KIND_LABELS[step.kind]}</Badge>
          {step.page?.title && (
            <span className="truncate text-xs text-subtle">{step.page.title}</span>
          )}
        </div>
        {step.kind !== 'note' && (
          <StepTitleEditor session={session} step={step} index={index} editable={editable} />
        )}
        {files.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <Link
                key={f.id}
                to={{ search: '?tab=downloads', hash: `#download-${f.id}` }}
                title="Ver na aba Downloads"
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-text hover:underline"
              >
                <span aria-hidden>⬇</span>
                <span className="truncate">{f.fileName}</span>
              </Link>
            ))}
          </div>
        )}
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            {step.kind === 'assert' && assertion && (
              <AssertionFields
                def={def}
                step={step}
                value={assertion}
                onChange={setAssertion}
                idPrefix={`assert-${step.id}`}
              />
            )}
            <Textarea
              aria-label={`Comentário do passo ${index + 1}`}
              value={comment}
              rows={2}
              maxLength={4000}
              placeholder={step.kind === 'checkpoint' ? 'O que foi verificado?' : undefined}
              autoFocus
              onChange={(e) => setComment(e.target.value)}
            />
            <label className="inline-flex items-center gap-2 text-xs text-muted">
              <Switch
                checked={isCode}
                onChange={setIsCode}
                label={`Comentário do passo ${index + 1} é código ou SQL`}
              />
              É código/SQL (aparece como bloco de código no documento)
            </label>
            <div className="flex gap-2">
              <Button size="sm" loading={busy === 'comment'} onClick={() => void saveComment()}>
                Salvar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setComment(step.comment ?? '');
                  setIsCode(step.commentIsCode ?? false);
                  setAssertion(step.assertion);
                  setEditing(false);
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          step.comment &&
          (step.commentIsCode ? (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg bg-accent-soft/40 px-2 py-1 font-mono text-xs">
              {step.comment}
            </pre>
          ) : (
            <p className={step.kind === 'note' ? 'mt-1 text-sm' : 'mt-1 text-xs text-muted'}>
              {step.comment}
            </p>
          ))
        )}
        {editable && menuSuggestion && !editing && step.comment !== menuSuggestion.text && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-2 py-1.5 text-xs text-accent-text">
            <Route className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 break-words">
              Caminho de menu detectado: {menuSuggestion.path.join(' > ')}
            </span>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'suggestion'}
              onClick={useSuggestion}
            >
              Usar como comentário
            </Button>
          </div>
        )}
        {image && editable && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <label className="inline-flex items-center gap-2 text-xs text-muted">
              <Switch
                checked={image.include}
                onChange={(include) => void run('include', () => api.patch(imageUrl, { include }))}
                label={`Incluir print do passo ${index + 1} no documento`}
              />
              Incluir print no documento
            </label>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Editar print do passo ${index + 1}`}
              onClick={onEditImage}
            >
              <PenLine className="h-4 w-4" /> Editar
            </Button>
            <ConfirmButton
              label={`Remover print do passo ${index + 1}`}
              onConfirm={() => void run('remove-image', () => api.del(imageUrl), 'Print removido')}
            >
              <Trash2 className="h-4 w-4" />
            </ConfirmButton>
          </div>
        )}
        {!image && step.kind === 'capture' && (
          <p className="mt-1 text-xs text-subtle">Print removido. O passo continua na lista.</p>
        )}
      </div>
      {image && (
        <StepThumbnail
          src={`${image.imageUrl}?v=${image.updatedAt}`}
          bbox={image.annotated || !step.target ? null : (step.target.bbox ?? null)}
          alt={`Print do passo ${index + 1}`}
          className="h-20 w-36 shrink-0"
        />
      )}
      {editable && (
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${step.kind === 'assert' ? 'Editar' : 'Comentar'} passo ${index + 1}`}
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {step.kind !== 'note' && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Iniciar caso de uso no passo ${index + 1}`}
              title="Iniciar um novo caso de uso antes deste passo"
              disabled={busy !== null}
              onClick={startUseCase}
            >
              <SeparatorHorizontal className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Subir passo ${index + 1}`}
            disabled={index === 0 || busy !== null}
            onClick={() => move(-1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Descer passo ${index + 1}`}
            disabled={index === ids.length - 1 || busy !== null}
            onClick={() => move(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <ConfirmButton
            label={`Excluir passo ${index + 1}`}
            onConfirm={() => void run('delete', () => api.del(url), 'Passo excluído')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ConfirmButton>
        </div>
      )}
    </Card>
  );
}

/** Moves a step `delta` positions (the divider of a use case moves like any other step). */
function reorder(session: TestSessionDto, index: number, delta: number) {
  const next = session.definition.steps.map((s) => s.id);
  const [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item!);
  return api.post(`/api/tests/sessions/${session.id}/steps/reorder`, { ids: next });
}

/** The "Caso de Uso" divider: title and status of the use case that starts here. */
function UseCaseRow({
  session,
  step,
  index,
  number,
  editable,
}: {
  session: TestSessionDto;
  step: TestStep;
  index: number;
  /** 0-based position among the use cases of the document. */
  number: number;
  editable: boolean;
}) {
  const { busy, run } = useSessionAction(session.id);
  const url = `/api/tests/sessions/${session.id}/steps/${step.id}`;
  const stored = step.useCase ?? { title: '', status: 'Finalizado' };
  const [title, setTitle] = useState(stored.title);
  const [status, setStatus] = useState(stored.status);
  const listId = `uc-status-${step.id}`;
  const dirty = title.trim() !== stored.title || status.trim() !== stored.status;
  const last = session.definition.steps.length - 1;
  return (
    <Card className="flex flex-wrap items-end gap-3 border-accent/40 bg-accent-soft/30 p-3">
      <div className="min-w-0 flex-1 basis-48">
        <label className="text-xs font-medium text-accent-text" htmlFor={`uc-title-${step.id}`}>
          Caso de uso {number + 1}
        </label>
        <Input
          id={`uc-title-${step.id}`}
          aria-label={`Título do caso de uso ${number + 1}`}
          value={title}
          maxLength={300}
          disabled={!editable}
          placeholder={useCaseDisplayTitle({ title: '' }, number)}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="w-44">
        <label className="text-xs font-medium text-muted" htmlFor={`uc-status-${step.id}`}>
          Status
        </label>
        <Input
          id={`uc-status-${step.id}`}
          aria-label={`Status do caso de uso ${number + 1}`}
          list={listId}
          value={status}
          maxLength={300}
          disabled={!editable}
          onChange={(e) => setStatus(e.target.value)}
        />
        <datalist id={listId}>
          {CT_USE_CASE_STATUS_SUGGESTIONS.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </div>
      {editable && (
        <div className="flex items-center gap-0.5">
          <Button
            size="sm"
            disabled={!dirty}
            loading={busy === 'use-case'}
            onClick={() =>
              void run('use-case', () =>
                api.patch(url, { useCase: { title: title.trim(), status: status.trim() } }),
              )
            }
          >
            Salvar
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Subir caso de uso ${number + 1}`}
            disabled={index === 0 || busy !== null}
            onClick={() => void run('move', () => reorder(session, index, -1))}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Descer caso de uso ${number + 1}`}
            disabled={index === last || busy !== null}
            onClick={() => void run('move', () => reorder(session, index, 1))}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <ConfirmButton
            label={`Excluir caso de uso ${number + 1}`}
            onConfirm={() => void run('delete', () => api.del(url), 'Caso de uso excluído')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ConfirmButton>
        </div>
      )}
    </Card>
  );
}

function AddUseCase({ session }: { session: TestSessionDto }) {
  const { busy, run } = useSessionAction(session.id);
  return (
    <Button
      variant="secondary"
      loading={busy === 'use-case'}
      onClick={() =>
        void run(
          'use-case',
          () => api.post(`/api/tests/sessions/${session.id}/steps/use-cases`, {}),
          'Caso de uso adicionado ao fim da lista',
        )
      }
    >
      <SeparatorHorizontal className="h-4 w-4" /> Adicionar caso de uso
    </Button>
  );
}

function AddNote({ session }: { session: TestSessionDto }) {
  const { busy, run } = useSessionAction(session.id);
  const [text, setText] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    const ok = await run('note', () =>
      api.post(`/api/tests/sessions/${session.id}/steps/notes`, { comment: text }),
    );
    if (ok) setText('');
  };
  return (
    <div className="mt-3 flex gap-2">
      <Textarea
        aria-label="Nova anotação"
        placeholder="Anotação livre na linha do tempo (pré-condição, observação, dado usado…)"
        rows={1}
        value={text}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
      />
      <Button
        variant="secondary"
        loading={busy === 'note'}
        disabled={!text.trim()}
        onClick={() => void add()}
      >
        <MessageSquarePlus className="h-4 w-4" /> Anotar
      </Button>
    </div>
  );
}

/** A PNG chosen or pasted (Ctrl+V) becomes a `capture` step: the screen of another system. */
function AddImage({
  session,
  onAdded,
}: {
  session: TestSessionDto;
  onAdded(image: TestStepImageDto): void;
}) {
  const { busy, run } = useSessionAction(session.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (blob: Blob) => {
    if (blob.type && blob.type !== 'image/png') {
      notify.warning('Use uma imagem PNG (prints colados já vêm em PNG).');
      return;
    }
    const form = new FormData();
    form.append('image', blob, 'colado.png');
    const result: { image: TestStepImageDto | null } = { image: null };
    const ok = await run(
      'upload',
      async () => {
        result.image = await api.upload<TestStepImageDto>(
          `/api/tests/sessions/${session.id}/steps/captures`,
          form,
        );
      },
      'Print adicionado',
    );
    if (ok && result.image) onAdded(result.image);
  };
  // Ctrl+V of a screenshot anywhere on the tab adds it
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input,textarea,[contenteditable]')) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      void upload(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        loading={busy === 'upload'}
        onClick={() => fileRef.current?.click()}
      >
        <ImagePlus className="h-4 w-4" /> Adicionar print
      </Button>
      <span className="text-xs text-muted">
        Ou cole um print (Ctrl+V): vira um passo “Print da tela” no fim da lista.
      </span>
      <input
        ref={fileRef}
        type="file"
        accept="image/png"
        hidden
        aria-label="Escolher imagem PNG"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** One print of the gallery: opens the annotation editor (when the session is not recording). */
function GalleryCard({
  session,
  step,
  index,
  image,
  editable,
  onOpen,
}: {
  session: TestSessionDto;
  step: TestStep;
  index: number;
  image: TestStepImageDto;
  editable: boolean;
  onOpen(): void;
}) {
  const { busy, run } = useSessionAction(session.id);
  const comment = step.comment?.trim() || image.comment.trim();
  const body = (
    <>
      <span className="relative block aspect-video w-full overflow-hidden border-b border-border bg-surface-2">
        <img
          src={`${image.imageUrl}?v=${image.updatedAt}`}
          alt={`Print do passo ${index + 1}`}
          loading="lazy"
          className="block h-full w-full object-cover object-top"
        />
        <span className="absolute left-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-white shadow">
          {index + 1}
        </span>
      </span>
      <span className="flex flex-col gap-1.5 p-2.5 text-left">
        <span className="flex flex-wrap items-center gap-1.5">
          {step.kind === 'checkpoint' && (
            <Badge tone="accent">
              <CircleCheck className="h-3 w-3" aria-hidden /> {STEP_KIND_LABELS.checkpoint}
            </Badge>
          )}
        </span>
        <span className="line-clamp-2 break-words text-xs text-muted">
          {stepTitle(session.definition, step)}
        </span>
        {comment && <span className="line-clamp-3 break-words text-sm">{comment}</span>}
      </span>
    </>
  );
  const tone = step.kind === 'checkpoint' ? 'border-accent/50' : 'border-border';
  const imageUrl = `/api/tests/sessions/${session.id}/evidences/${image.id}`;
  return (
    <div
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-2xl border bg-surface',
        tone,
        !image.include && 'opacity-80',
      )}
    >
      {editable ? (
        <button
          type="button"
          aria-label={`Abrir print do passo ${index + 1}`}
          onClick={onOpen}
          className="flex w-full flex-1 cursor-pointer flex-col transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {body}
        </button>
      ) : (
        <div className="flex w-full flex-1 flex-col">{body}</div>
      )}
      <div className="flex items-center gap-2 border-t border-border px-2.5 py-2 text-xs">
        <Switch
          checked={image.include}
          disabled={!editable || busy !== null}
          onChange={(include) => void run('include', () => api.patch(imageUrl, { include }))}
          label={`Incluir print do passo ${index + 1} no documento`}
        />
        <span className={image.include ? 'font-medium text-success' : 'text-muted'}>
          {image.include ? 'No documento' : 'Fora do documento'}
        </span>
      </div>
    </div>
  );
}

/** Every print of the session in order, to find the one to edit at a glance. */
function ImageGallery({
  session,
  filter,
  editable,
  onOpen,
}: {
  session: TestSessionDto;
  filter: StepsFilter;
  editable: boolean;
  onOpen(stepId: string): void;
}) {
  const cards = session.definition.steps.flatMap((step, index) => {
    const image = session.images[step.id];
    if (!image || (filter === 'checks' && step.kind !== 'checkpoint')) return [];
    return [{ step, index, image }];
  });
  if (cards.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks className="h-6 w-6" />}
        title={filter === 'checks' ? 'Nenhuma verificação ainda' : 'Nenhum print ainda'}
        description={
          filter === 'checks'
            ? 'Use Verificar durante a gravação: ele tira um print da tela inteira e o marca como verificação.'
            : 'Os prints dos passos aparecem aqui, na ordem em que foram tirados.'
        }
      />
    );
  }
  return (
    <ol
      aria-label="Prints dos passos"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {cards.map(({ step, index, image }) => (
        <li key={step.id} className="flex">
          <GalleryCard
            session={session}
            step={step}
            index={index}
            image={image}
            editable={editable}
            onOpen={() => onOpen(step.id)}
          />
        </li>
      ))}
    </ol>
  );
}

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(next: T): void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[10px] px-3 py-1 text-xs font-medium transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StepsViewBar({
  view,
  filter,
  onView,
  onFilter,
}: {
  view: StepsView;
  filter: StepsFilter;
  onView(next: StepsView): void;
  onFilter(next: StepsFilter): void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <ChoiceGroup
        label="Visualização dos passos"
        value={view}
        onChange={onView}
        options={[
          { value: 'list', label: 'Lista' },
          { value: 'images', label: 'Imagens' },
        ]}
      />
      <ChoiceGroup
        label="Filtro dos passos"
        value={filter}
        onChange={onFilter}
        options={[
          { value: 'all', label: 'Todas' },
          { value: 'checks', label: 'Só verificações' },
        ]}
      />
    </div>
  );
}

export function StepsTab({ session }: { session: TestSessionDto }) {
  const def = session.definition;
  const editable = session.state === 'idle';
  // the step whose print is open in the editor lives in the URL, so a new capture can open it
  const [params, setParams] = useSearchParams();
  const editing = params.get('edit');
  const setEditing = (stepId: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (stepId) next.set('edit', stepId);
        else next.delete('edit');
        return next;
      },
      { replace: true },
    );
  const editedImage = editing ? (session.images[editing] ?? null) : null;
  const capturing = sessionMode(def) === 'capture';
  // use cases of the CT document: a divider starts one; steps before the first form "Caso de Uso 1"
  const segments = splitUseCases(
    def.steps,
    (step) => stepHasCtContent(step, session.images[step.id]),
    def.ct?.firstUseCase,
  );
  const numberOfDivider = new Map(segments.map((seg, i) => [seg.stepId, i]));
  const implicitFirst = segments[0]?.stepId === null && def.steps[0]?.kind !== 'usecase';
  const menuPaths = menuPathByStep(def.steps);
  const { view, filter, setView, setFilter } = useStepsView();
  useScrollToHash();
  const checksOnly = filter === 'checks';

  const editor = editedImage && (
    <Suspense fallback={<p className="text-sm text-muted">Abrindo o editor…</p>}>
      <AnnotationEditor
        key={editedImage.id}
        session={session}
        evidence={editedImage}
        onClose={() => setEditing(null)}
      />
    </Suspense>
  );

  if (def.steps.length === 0) {
    return (
      <>
        <EmptyState
          icon={<ListChecks className="h-6 w-6" />}
          title={capturing ? 'Nenhum print ainda' : 'Nenhum passo gravado'}
          description={
            capturing
              ? 'Inicie a captura: cada print que você tirar vira um passo aqui, com um editor para marcar e comentar.'
              : 'Inicie a gravação: cada clique, preenchimento e navegação aparece aqui na ordem em que aconteceu, com o print da tela.'
          }
        />
        {editable && <AddImage session={session} onAdded={(i) => setEditing(i.stepId)} />}
        {editable && <AddNote session={session} />}
        {editor}
      </>
    );
  }
  return (
    <>
      {!editable && (
        <p className="mb-3 text-xs text-muted">
          Os passos aparecem aqui enquanto você usa o navegador. Pare a gravação para editá-los.
        </p>
      )}
      <StepsViewBar view={view} filter={filter} onView={setView} onFilter={setFilter} />
      {view === 'images' ? (
        <ImageGallery
          session={session}
          filter={filter}
          editable={editable}
          onOpen={(stepId) => setEditing(stepId)}
        />
      ) : checksOnly && !def.steps.some((s) => s.kind === 'checkpoint') ? (
        <EmptyState
          icon={<ListChecks className="h-6 w-6" />}
          title="Nenhuma verificação ainda"
          description="Use Verificar durante a gravação: ele tira um print da tela inteira e o marca como verificação."
        />
      ) : (
        <ol className="flex flex-col gap-2">
          {implicitFirst && !checksOnly && (
            <li className="px-1 text-xs font-medium text-accent-text">
              Caso de Uso 1: os passos abaixo, até o próximo divisor de caso de uso
            </li>
          )}
          {def.steps.map((step, index) =>
            checksOnly && step.kind !== 'checkpoint' ? null : (
              <li key={step.id}>
                {step.kind === 'usecase' ? (
                  <UseCaseRow
                    key={JSON.stringify(step.useCase)}
                    session={session}
                    step={step}
                    index={index}
                    number={numberOfDivider.get(step.id) ?? 0}
                    editable={editable}
                  />
                ) : (
                  <StepRow
                    session={session}
                    step={step}
                    index={index}
                    editable={editable}
                    {...(menuPaths.has(step.id) ? { menuSuggestion: menuPaths.get(step.id)! } : {})}
                    onEditImage={() => setEditing(step.id)}
                  />
                )}
              </li>
            ),
          )}
        </ol>
      )}
      {editable && <AddImage session={session} onAdded={(i) => setEditing(i.stepId)} />}
      {editable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <AddUseCase session={session} />
          <span className="text-xs text-muted">
            Cada caso de uso vira um bloco no documento CT; use o botão de cada passo para dividir
            no meio da lista.
          </span>
        </div>
      )}
      {editable && <AddNote session={session} />}
      {editor}
    </>
  );
}
