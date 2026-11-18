import { useQueryClient } from '@tanstack/react-query';
import type {
  LibraryDetailDto,
  LibraryDocumentDto,
  LibraryDocumentTextDto,
} from '@thinkflow/shared';
import { Eye, LoaderCircle, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card } from '../../components/ui/card';
import { ConfirmButton, Dialog } from '../../components/ui/dialog';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys } from '../../lib/queries';
import { formatNumber } from '../../lib/utils';
import {
  EXTRACTION_LABELS,
  formatBytes,
  isWaitingOcr,
  KIND_LABELS,
  REMOTE_LABELS,
  statusView,
} from './format';

function StatusBadge({ doc }: { doc: LibraryDocumentDto }) {
  const view = statusView(doc);
  return (
    <Badge tone={view.tone} className="max-w-48">
      {view.spinner && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />}
      <span title={view.detail ?? undefined} className="truncate">
        {view.label}
      </span>
    </Badge>
  );
}

function TextDialog({
  libraryId,
  doc,
  onClose,
}: {
  libraryId: string;
  doc: LibraryDocumentDto | null;
  onClose(): void;
}) {
  const [text, setText] = useState('');
  const [state, setState] = useState<{ total: number; hasMore: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (target: LibraryDocumentDto, offset: number) => {
    setLoading(true);
    try {
      const page = await api.get<LibraryDocumentTextDto>(
        `/api/libraries/${libraryId}/documents/${target.id}/text?offset=${offset}&limit=20000`,
      );
      setText((prev) => (offset === 0 ? page.text : prev + page.text));
      setState({ total: page.total, hasMore: page.hasMore });
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const docId = doc?.id ?? null;
  // lazy load when a document is opened
  useEffect(() => {
    setText('');
    setState(null);
    if (doc) void load(doc, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  return (
    <Dialog
      open={doc !== null}
      onClose={onClose}
      size="lg"
      title={doc ? `Texto extraído — ${doc.name}` : 'Texto extraído'}
      description={state ? `${formatNumber(state.total)} caracteres no total` : undefined}
      footer={
        <>
          {state?.hasMore && doc && (
            <Button
              variant="secondary"
              loading={loading}
              onClick={() => void load(doc, text.length)}
            >
              Carregar mais
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
        </>
      }
    >
      {loading && !text ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : text ? (
        <pre className="text-sm whitespace-pre-wrap break-words">{text}</pre>
      ) : (
        <p className="text-sm text-muted">Nenhum texto extraído.</p>
      )}
    </Dialog>
  );
}

export function DocumentsTable({ library }: { library: LibraryDetailDto }) {
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<LibraryDocumentDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const isRemote = library.engine === 'notebooklm';
  const base = `/api/libraries/${library.id}/documents`;

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.libraries });

  const act = async (doc: LibraryDocumentDto, action: 'reindex' | 'sync' | 'delete') => {
    setBusyId(doc.id);
    try {
      if (action === 'delete') await api.del(`${base}/${doc.id}`);
      else await api.post(`${base}/${doc.id}/${action}`);
      await refresh();
      if (action === 'delete') notify.success('Documento excluído');
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  if (library.documents.length === 0)
    return (
      <Card className="px-6 py-8 text-center text-sm text-muted">
        Nenhum documento ainda. Envie arquivos acima para começar.
      </Card>
    );

  return (
    <>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-4 py-3 font-medium">Nome</th>
              <th className="px-3 py-3 font-medium">Tipo</th>
              <th className="px-3 py-3 font-medium">Tamanho</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Extração</th>
              <th className="px-3 py-3 text-right font-medium">Trechos</th>
              <th className="px-3 py-3 text-right font-medium">Páginas</th>
              {isRemote && <th className="px-3 py-3 font-medium">NotebookLM</th>}
              <th className="px-3 py-3 text-right font-medium">Ações</th>
            </tr>
          </thead>
          <tbody>
            {library.documents.map((doc) => {
              const busy = busyId === doc.id;
              return (
                <tr key={doc.id} className="border-b border-border last:border-0">
                  <td className="max-w-64 px-4 py-3">
                    <span className="block truncate font-medium" title={doc.name}>
                      {doc.name}
                    </span>
                    {doc.status === 'error' && doc.error && (
                      <span
                        className={
                          isWaitingOcr(doc)
                            ? 'block truncate text-xs text-warning'
                            : 'block truncate text-xs text-danger'
                        }
                        title={doc.error}
                      >
                        {doc.error}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-muted">{KIND_LABELS[doc.kind]}</td>
                  <td className="px-3 py-3 whitespace-nowrap text-muted">
                    {formatBytes(doc.sizeBytes)}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge doc={doc} />
                  </td>
                  <td className="px-3 py-3 text-muted">
                    {doc.extraction ? EXTRACTION_LABELS[doc.extraction] : '—'}
                  </td>
                  <td className="px-3 py-3 text-right text-muted">{doc.chunkCount}</td>
                  <td className="px-3 py-3 text-right text-muted">{doc.pageCount ?? '—'}</td>
                  {isRemote && (
                    <td className="px-3 py-3">
                      {doc.remote ? (
                        <Badge
                          tone={
                            doc.remote.status === 'synced'
                              ? 'success'
                              : doc.remote.status === 'error'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          <span title={doc.remote.error ?? undefined}>
                            {REMOTE_LABELS[doc.remote.status]}
                          </span>
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                  )}
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Ver texto de ${doc.name}`}
                        title="Ver texto"
                        disabled={doc.status !== 'ready'}
                        onClick={() => setViewing(doc)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Reprocessar ${doc.name}`}
                        title="Reprocessar"
                        disabled={busy || doc.status === 'processing'}
                        onClick={() => void act(doc, 'reindex')}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      {isRemote && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Sincronizar ${doc.name}`}
                          title="Sincronizar com o NotebookLM"
                          disabled={busy}
                          onClick={() => void act(doc, 'sync')}
                        >
                          <UploadCloud className="h-4 w-4" />
                        </Button>
                      )}
                      <ConfirmButton
                        label={`Excluir ${doc.name}`}
                        confirmLabel="Excluir este documento?"
                        onConfirm={() => void act(doc, 'delete')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </ConfirmButton>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <TextDialog libraryId={library.id} doc={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
