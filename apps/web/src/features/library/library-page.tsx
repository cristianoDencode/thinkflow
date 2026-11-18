import { useQueryClient } from '@tanstack/react-query';
import {
  LIBRARY_ACCEPT,
  LIBRARY_LIMITS,
  maxDocumentsFor,
  type LibraryDto,
  type LibraryUploadResultDto,
  type NotebookLmSettingsDto,
} from '@thinkflow/shared';
import {
  Library as LibraryIcon,
  LoaderCircle,
  Paperclip,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Tabs } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useLibraries, useNotebookLmSettings } from '../../lib/queries';
import { cn, timeAgo } from '../../lib/utils';
import { chunk, formatBytes, splitFiles } from './format';
import { LibrarySettingsCard } from './library-settings-card';
import { NotebookLmSettingsCard } from './notebooklm-settings-card';

type Tab = 'libraries' | 'settings' | 'notebooklm';

export function EngineBadge({ engine }: { engine: LibraryDto['engine'] }) {
  return engine === 'notebooklm' ? (
    <Badge tone="warning">NotebookLM · experimental</Badge>
  ) : (
    <Badge>Local</Badge>
  );
}

function LibraryCard({
  library: lib,
  notebookLm,
}: {
  library: LibraryDto;
  notebookLm: NotebookLmSettingsDto | undefined;
}) {
  return (
    <Link
      to={`/library/${lib.id}`}
      className="block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:bg-surface-hover">
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 truncate font-medium">{lib.name}</h2>
          <EngineBadge engine={lib.engine} />
        </div>
        <p className={cn('line-clamp-2 text-sm', lib.description ? 'text-muted' : 'text-subtle')}>
          {lib.description || 'Sem descrição'}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            {lib.documentCount}/{lib.maxDocuments} documentos
          </span>
          {lib.processingCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
              {lib.processingCount} processando
            </span>
          )}
          {lib.errorCount > 0 && (
            <span className="inline-flex items-center gap-1 text-danger">
              <TriangleAlert className="h-3 w-3" aria-hidden />
              {lib.errorCount} com erro
            </span>
          )}
          {lib.engine === 'notebooklm' && notebookLm && (
            <span>
              Consultas hoje: {notebookLm.queriesToday}/{notebookLm.dailyQueryLimit}
            </span>
          )}
          <span className="text-subtle">Atualizada {timeAgo(lib.updatedAt)}</span>
        </div>
      </Card>
    </Link>
  );
}

/** Uploads in batches; returns how many files were not accepted. */
async function uploadFiles(libraryId: string, list: File[], maxDocuments: number): Promise<number> {
  if (list.length === 0) return 0;
  const split = splitFiles(list, maxDocuments, maxDocuments);
  let rejected = split.rejected.length;
  for (const batch of chunk(split.accepted, LIBRARY_LIMITS.maxFilesPerUpload)) {
    const form = new FormData();
    for (const file of batch) form.append('files', file, file.name);
    try {
      const result = await api.upload<LibraryUploadResultDto>(
        `/api/libraries/${libraryId}/documents`,
        form,
      );
      rejected += result.rejected.length;
    } catch {
      rejected += batch.length;
    }
  }
  return rejected;
}

function CreateLibraryDialog({
  open,
  onClose,
  notebookLm,
}: {
  open: boolean;
  onClose(): void;
  notebookLm: NotebookLmSettingsDto | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [engine, setEngine] = useState<'local' | 'notebooklm'>('local');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  // credentials are enough: if the integration is switched off, it is turned on on submit
  const notebookLmReady = Boolean(notebookLm?.hasCredentials);
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const remote = engine === 'notebooklm' && notebookLmReady;
  const maxDocuments = maxDocumentsFor(remote ? 'notebooklm' : 'local', notebookLm?.sourceLimit);

  const close = () => {
    setName('');
    setDescription('');
    setEngine('local');
    setConsent(false);
    setFiles([]);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (remote && !consent)) return;
    setBusy(true);
    try {
      if (remote && !notebookLm?.enabled)
        await api.put('/api/library/notebooklm', { enabled: true });
      const created = await api.post<LibraryDto>('/api/libraries', {
        name: name.trim(),
        description: description.trim(),
        engine: remote ? 'notebooklm' : 'local',
        ...(remote ? { acceptRemoteUpload: true } : {}),
      });
      const rejected = await uploadFiles(created.id, files, created.maxDocuments);
      await queryClient.invalidateQueries({ queryKey: keys.libraries });
      notify.success(
        files.length > 0
          ? `Biblioteca criada com ${files.length - rejected} ${files.length - rejected === 1 ? 'documento' : 'documentos'}`
          : 'Biblioteca criada',
      );
      if (rejected > 0) notify.warning(`${rejected} arquivo(s) não foram aceitos`);
      close();
      navigate(`/library/${created.id}`);
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Nova biblioteca"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="create-library-form"
            loading={busy}
            disabled={!name.trim() || (remote && !consent)}
          >
            Criar biblioteca
          </Button>
        </>
      }
    >
      <form
        id="create-library-form"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4"
      >
        <Field label="Nome" htmlFor="library-name">
          <Input
            id="library-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Contratos 2026"
            required
          />
        </Field>
        <Field label="Descrição (opcional)" htmlFor="library-description">
          <Textarea
            id="library-description"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Documentos (opcional)</span>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={LIBRARY_ACCEPT}
            className="sr-only"
            aria-label="Anexar documentos"
            data-testid="create-file-input"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              setFiles((prev) => [...prev, ...picked].slice(0, maxDocuments));
              if (fileInput.current) fileInput.current.value = '';
            }}
          />
          <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
            <Paperclip className="h-4 w-4" aria-hidden /> Anexar arquivos
          </Button>
          {files.length > 0 && (
            <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-xl border border-border p-2 text-sm">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {f.name} <span className="text-xs text-muted">({formatBytes(f.size)})</span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remover ${f.name}`}
                    className="rounded p-1 text-muted hover:bg-surface-hover hover:text-fg"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            PDF, Word, Markdown, texto e imagens · até 20 MB por arquivo. Você também pode enviar
            depois.
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">Mecanismo de busca</legend>
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-xl border p-3',
              engine === 'local' ? 'border-accent bg-accent-soft' : 'border-border',
            )}
          >
            <input
              type="radio"
              name="engine"
              value="local"
              checked={engine === 'local'}
              onChange={() => setEngine('local')}
              className="mt-1"
            />
            <span className="text-sm">
              <span className="font-medium">Local</span>
              <span className="block text-muted">
                Indexação no seu servidor; nada sai da sua máquina. Até{' '}
                {LIBRARY_LIMITS.maxLocalDocuments} documentos.
              </span>
            </span>
          </label>
          <label
            className={cn(
              'flex items-start gap-3 rounded-xl border p-3',
              notebookLmReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
              remote ? 'border-accent bg-accent-soft' : 'border-border',
            )}
          >
            <input
              type="radio"
              name="engine"
              value="notebooklm"
              checked={engine === 'notebooklm'}
              disabled={!notebookLmReady}
              onChange={() => setEngine('notebooklm')}
              className="mt-1"
            />
            <span className="text-sm">
              <span className="font-medium">NotebookLM (experimental)</span>
              <span className="block text-muted">
                {notebookLmReady
                  ? `A pergunta da IA é respondida pelo NotebookLM, com citações. Mais lento. Limite da conta: ${notebookLm?.sourceLimit ?? LIBRARY_LIMITS.defaultNotebookLmSources} documentos por biblioteca.`
                  : 'Configure na aba NotebookLM'}
              </span>
            </span>
          </label>
          {remote && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-1"
              />
              <span>
                Entendo que os documentos serão enviados para a conta Google configurada (serviço
                não oficial, pode parar de funcionar).
              </span>
            </label>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>('libraries');
  const [creating, setCreating] = useState(false);
  const { data: libraries = [], isLoading, error } = useLibraries();
  const { data: notebookLm } = useNotebookLmSettings();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Biblioteca"
        description="Conecte documentos ao chat — a IA consulta só os trechos relevantes."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Nova biblioteca
          </Button>
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'libraries', label: 'Bibliotecas', count: libraries.length },
          { value: 'settings', label: 'Configurações' },
          { value: 'notebooklm', label: 'NotebookLM (experimental)' },
        ]}
      />
      {tab === 'libraries' &&
        (isLoading ? (
          <p className="text-sm text-muted">Carregando…</p>
        ) : error ? (
          <p className="text-sm text-danger">{errorMessage(error)}</p>
        ) : libraries.length === 0 ? (
          <EmptyState
            icon={<LibraryIcon className="h-6 w-6" />}
            title="Nenhuma biblioteca ainda"
            description="Crie uma biblioteca, envie PDFs, documentos Word, textos ou imagens e conecte-a ao chat."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> Nova biblioteca
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {libraries.map((lib) => (
              <LibraryCard key={lib.id} library={lib} notebookLm={notebookLm} />
            ))}
          </div>
        ))}
      {tab === 'settings' && <LibrarySettingsCard />}
      {tab === 'notebooklm' && <NotebookLmSettingsCard />}
      <CreateLibraryDialog
        open={creating}
        onClose={() => setCreating(false)}
        notebookLm={notebookLm}
      />
    </div>
  );
}
