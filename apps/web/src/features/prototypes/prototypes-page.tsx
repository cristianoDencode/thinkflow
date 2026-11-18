import { useQueryClient } from '@tanstack/react-query';
import { ECIDADE_WINDOW_TEMPLATE_ID, type PrototypeDto } from '@thinkflow/shared';
import { LayoutTemplate, Play, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select } from '../../components/ui/form';
import { errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { useTestSessions } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { NewPrototypeDialog } from './new-prototype-dialog';
import { PrototypeCard } from './prototype-card';
import {
  duplicatePrototype,
  protoKeys,
  usePrototypes,
  useDeletePrototype,
  useTemplates,
  useUpdatePrototype,
} from './queries';

const NO_SESSION = '__none__';

const haystack = (p: PrototypeDto) =>
  [p.name, p.source.file, p.source.menuPath, p.source.title, p.source.url, p.sessionName]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('pt-BR');

export function filterPrototypes(list: PrototypeDto[], text: string, sessionId: string) {
  const needle = text.trim().toLocaleLowerCase('pt-BR');
  return list.filter((p) => {
    if (sessionId === NO_SESSION ? p.sessionId !== null : sessionId && p.sessionId !== sessionId)
      return false;
    return !needle || haystack(p).includes(needle);
  });
}

function RenameDialog({ prototype, onClose }: { prototype: PrototypeDto; onClose(): void }) {
  const update = useUpdatePrototype(prototype.id);
  const [name, setName] = useState(prototype.name);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await update.mutateAsync({ name: trimmed });
      notify.success('Protótipo renomeado');
      onClose();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Renomear protótipo"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={update.isPending} onClick={() => void submit()}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Nome" htmlFor="proto-rename">
          <Input
            id="proto-rename"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

type Tab = 'prototypes' | 'templates';

/** The built-in template: read-only, only "use" it. */
function BuiltinTemplateCard({
  name,
  description,
  thumbnailUrl,
  onUse,
}: {
  name: string;
  description: string;
  thumbnailUrl: string | null;
  onUse(): void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex aspect-video items-center justify-center overflow-hidden border-b border-border bg-surface-2">
        {thumbnailUrl && !failed ? (
          <img
            src={thumbnailUrl}
            alt={`Prévia de ${name}`}
            loading="lazy"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <LayoutTemplate className="h-8 w-8 text-subtle" aria-hidden />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{name}</span>
          <Badge tone="success">Padrão</Badge>
        </div>
        <p className="text-xs text-muted">{description}</p>
        <p className="mt-auto pt-1 text-xs text-subtle">Modelo padrão: somente leitura.</p>
      </div>
      <div className="flex border-t border-border px-3 py-2">
        <Button variant="ghost" size="sm" aria-label={`Usar modelo ${name}`} onClick={onUse}>
          <Play className="h-4 w-4" /> Usar este modelo
        </Button>
      </div>
    </Card>
  );
}

export function PrototypesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'modelos' ? 'templates' : 'prototypes');
  const [templateId, setTemplateId] = useState<string | undefined>();
  const { data: prototypes, isLoading, error, dataUpdatedAt } = usePrototypes('prototype');
  const { data: mine, isLoading: loadingMine } = usePrototypes('template', tab === 'templates');
  const { data: templates } = useTemplates(tab === 'templates');
  const { data: sessions = [] } = useTestSessions();
  const remove = useDeletePrototype();
  const [text, setText] = useState('');
  const [sessionId, setSessionId] = useState(params.get('session') ?? '');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<PrototypeDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = useMemo(
    () => filterPrototypes(prototypes ?? [], text, sessionId),
    [prototypes, text, sessionId],
  );

  const visibleTemplates = useMemo(() => filterPrototypes(mine ?? [], text, ''), [mine, text]);
  const builtin = templates?.find((t) => t.id === ECIDADE_WINDOW_TEMPLATE_ID);

  const changeSession = (value: string) => {
    setSessionId(value);
    setParams(value ? { session: value } : {}, { replace: true });
  };

  const changeTab = (value: Tab) => {
    setTab(value);
    setParams(
      value === 'templates' ? { tab: 'modelos' } : sessionId ? { session: sessionId } : {},
      { replace: true },
    );
  };

  const duplicate = async (p: PrototypeDto) => {
    setBusyId(p.id);
    try {
      await duplicatePrototype(p);
      await queryClient.invalidateQueries({ queryKey: protoKeys.list });
      notify.success('Protótipo duplicado');
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async (p: PrototypeDto, done = 'Protótipo excluído') => {
    try {
      await remove.mutateAsync(p.id);
      notify.success(done);
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus className="h-4 w-4" /> Novo protótipo
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Protótipos"
        description="Monte e ajuste telas como blocos de montar e gere a imagem para o documento de teste. Os protótipos capturados vêm da gravação em Testes."
        actions={newButton}
      />
      <div
        role="tablist"
        aria-label="Protótipos e modelos"
        className="mb-5 flex border-b border-border"
      >
        {(
          [
            ['prototypes', 'Protótipos'],
            ['templates', 'Modelos'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => changeTab(value)}
            className={cn(
              'cursor-pointer px-4 py-2.5 text-sm font-medium transition-colors',
              tab === value
                ? 'border-b-2 border-accent text-accent-text'
                : 'text-muted hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'templates' ? (
        <>
          <p className="mb-4 text-sm text-muted">
            Modelos são pontos de partida: ao criar um protótipo a partir de um modelo, o conteúdo é
            copiado e os dois passam a ser independentes. Salve qualquer protótipo como modelo no
            editor.
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {builtin && (
              <li>
                <BuiltinTemplateCard
                  name={builtin.name}
                  description={builtin.description}
                  thumbnailUrl={builtin.thumbnailUrl}
                  onUse={() => {
                    setTemplateId(builtin.id);
                    setCreating(true);
                  }}
                />
              </li>
            )}
            {visibleTemplates.map((p) => (
              <li key={p.id}>
                <PrototypeCard
                  prototype={p}
                  fetchedAt={dataUpdatedAt}
                  onRename={() => setRenaming(p)}
                  onDelete={() => void doDelete(p, 'Modelo excluído')}
                  onUse={() => {
                    setTemplateId(p.id);
                    setCreating(true);
                  }}
                />
              </li>
            ))}
          </ul>
          {loadingMine ? (
            <p className="mt-4 text-sm text-muted">Carregando modelos…</p>
          ) : (mine?.length ?? 0) === 0 ? (
            <p className="mt-4 text-sm text-muted">
              Você ainda não tem modelos próprios. Abra um protótipo e use “Salvar como modelo”.
            </p>
          ) : null}
        </>
      ) : (
        <>
          {isLoading ? (
            <p className="text-sm text-muted">Carregando protótipos…</p>
          ) : error ? (
            <p role="alert" className="text-sm text-danger">
              Não foi possível carregar os protótipos: {errorMessage(error)}
            </p>
          ) : !prototypes || prototypes.length === 0 ? (
            <EmptyState
              icon={<LayoutTemplate className="h-6 w-6" />}
              title="Nenhum protótipo ainda"
              description="Os protótipos são capturados com o botão “Protótipo” enquanto você grava um teste em Testes. Você também pode começar de uma tela em branco ou colar o HTML de uma tela."
              action={newButton}
            />
          ) : (
            <>
              <Card className="mb-5 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    aria-label="Buscar protótipos"
                    placeholder="Buscar por nome, arquivo ou menu…"
                    className="pl-9"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </div>
                <Select
                  aria-label="Filtrar por sessão de teste"
                  className="sm:w-72"
                  value={sessionId}
                  onChange={(e) => changeSession(e.target.value)}
                >
                  <option value="">Todas as sessões</option>
                  <option value={NO_SESSION}>Sem sessão vinculada</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Card>
              {visible.length === 0 ? (
                <p className="text-sm text-muted">Nenhum protótipo corresponde ao filtro.</p>
              ) : (
                <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {visible.map((p) => (
                    <li key={p.id}>
                      <PrototypeCard
                        prototype={p}
                        fetchedAt={dataUpdatedAt}
                        busy={busyId === p.id}
                        onRename={() => setRenaming(p)}
                        onDuplicate={() => void duplicate(p)}
                        onDelete={() => void doDelete(p)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
      {creating && (
        <NewPrototypeDialog
          sessions={sessions}
          initialSessionId={sessionId && sessionId !== NO_SESSION ? sessionId : undefined}
          {...(templateId ? { initialTemplateId: templateId } : {})}
          onClose={() => {
            setCreating(false);
            setTemplateId(undefined);
          }}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/prototypes/${id}`);
          }}
        />
      )}
      {renaming && <RenameDialog prototype={renaming} onClose={() => setRenaming(null)} />}
    </div>
  );
}
