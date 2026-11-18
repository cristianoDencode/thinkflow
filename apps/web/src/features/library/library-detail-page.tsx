import { useQueryClient } from '@tanstack/react-query';
import { type LibraryDetailDto } from '@thinkflow/shared';
import { ArrowLeft, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Card, PageHeader } from '../../components/ui/card';
import { ConfirmButton, Dialog } from '../../components/ui/dialog';
import { Field, Input, Textarea } from '../../components/ui/form';
import { api, ApiError, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useLibrary, useNotebookLmSettings } from '../../lib/queries';
import { DocumentsTable } from './documents-table';
import { EngineBadge } from './library-page';
import { SearchPreview } from './search-preview';
import { UploadDropzone } from './upload-dropzone';

function EditDialog({ library, onClose }: { library: LibraryDetailDto | null; onClose(): void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [initFor, setInitFor] = useState<string | null>(null);

  if (library && initFor !== library.id) {
    setInitFor(library.id);
    setName(library.name);
    setDescription(library.description);
  }
  if (!library && initFor !== null) setInitFor(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!library || !name.trim()) return;
    setBusy(true);
    try {
      await api.patch(`/api/libraries/${library.id}`, {
        name: name.trim(),
        description: description.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: keys.libraries });
      notify.success('Biblioteca atualizada');
      onClose();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={library !== null}
      onClose={onClose}
      title="Editar biblioteca"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="edit-library-form" loading={busy} disabled={!name.trim()}>
            Salvar
          </Button>
        </>
      }
    >
      <form id="edit-library-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Nome" htmlFor="edit-library-name">
          <Input
            id="edit-library-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Descrição" htmlFor="edit-library-description">
          <Textarea
            id="edit-library-description"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

export function LibraryDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: library, isLoading, error } = useLibrary(id);
  const { data: notebookLm } = useNotebookLmSettings();
  const [editing, setEditing] = useState<LibraryDetailDto | null>(null);

  const remove = async () => {
    if (!library) return;
    try {
      await api.del(`/api/libraries/${library.id}`);
      queryClient.removeQueries({ queryKey: [...keys.libraries, 'detail', library.id] });
      await queryClient.invalidateQueries({ queryKey: keys.libraries });
      notify.success('Biblioteca excluída');
      navigate('/library');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const back = (
    <Link
      to="/library"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden /> Bibliotecas
    </Link>
  );

  if (isLoading)
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
        {back}
        <p className="text-sm text-muted">Carregando…</p>
      </div>
    );

  if (error || !library)
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
        {back}
        <Card className="p-6 text-sm">
          {error instanceof ApiError && error.status === 404
            ? 'Biblioteca não encontrada.'
            : errorMessage(error ?? 'Biblioteca não encontrada.')}
        </Card>
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      {back}
      <PageHeader
        title={library.name}
        description={
          <span className="flex flex-col gap-2">
            {library.description && <span>{library.description}</span>}
            <span className="flex items-center gap-2">
              <EngineBadge engine={library.engine} />
              <span className="text-xs">
                {library.documentCount}/{library.maxDocuments} documentos
              </span>
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(library)}>
              <Pencil className="h-4 w-4" /> Editar
            </Button>
            <ConfirmButton
              label="Excluir biblioteca"
              confirmLabel="Excluir a biblioteca e todos os documentos?"
              onConfirm={() => void remove()}
              className="h-10 w-10 text-danger"
            >
              <Trash2 className="h-4 w-4" />
            </ConfirmButton>
          </>
        }
      />
      {library.engine === 'notebooklm' && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Experimental: os documentos e perguntas são enviados à sua conta Google (NotebookLM,
            serviço não oficial). As respostas levam alguns segundos e, se o NotebookLM falhar, a IA
            recebe os trechos do índice local.
            {notebookLm && (
              <strong className="ml-1 font-medium">
                Consultas hoje: {notebookLm.queriesToday}/{notebookLm.dailyQueryLimit}
              </strong>
            )}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-6">
        <UploadDropzone
          libraryId={library.id}
          documentCount={library.documentCount}
          maxDocuments={library.maxDocuments}
        />
        <DocumentsTable library={library} />
        <SearchPreview libraryId={library.id} engine={library.engine} />
      </div>
      <EditDialog library={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
