import { useQueryClient } from '@tanstack/react-query';
import { LIBRARY_ACCEPT, LIBRARY_LIMITS, type LibraryUploadResultDto } from '@thinkflow/shared';
import { Upload } from 'lucide-react';
import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { chunk, splitFiles } from './format';

type Rejected = { name: string; reason: string };

export function UploadDropzone({
  libraryId,
  documentCount,
  maxDocuments,
}: {
  libraryId: string;
  documentCount: number;
  /** From the library DTO: fixed for local libraries, the account's source limit for NotebookLM. */
  maxDocuments: number;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const uploading = progress !== null;
  const freeSlots = Math.max(0, maxDocuments - documentCount);

  const upload = async (list: File[]) => {
    if (list.length === 0 || uploading) return;
    const split = splitFiles(list, freeSlots, maxDocuments);
    const allRejected: Rejected[] = [...split.rejected];
    let sent = 0;
    if (split.accepted.length > 0) {
      setProgress({ done: 0, total: split.accepted.length });
      for (const batch of chunk(split.accepted, LIBRARY_LIMITS.maxFilesPerUpload)) {
        const form = new FormData();
        for (const file of batch) form.append('files', file, file.name);
        try {
          const result = await api.upload<LibraryUploadResultDto>(
            `/api/libraries/${libraryId}/documents`,
            form,
          );
          sent += result.accepted.length;
          allRejected.push(...result.rejected);
        } catch (err) {
          const reason = errorMessage(err);
          allRejected.push(...batch.map((f) => ({ name: f.name, reason })));
        }
        setProgress((p) => (p ? { ...p, done: p.done + batch.length } : p));
        await queryClient.invalidateQueries({ queryKey: keys.libraries });
      }
      setProgress(null);
    }
    setRejected(allRejected);
    if (sent > 0)
      notify.success(`${sent} ${sent === 1 ? 'documento enviado' : 'documentos enviados'}`);
    if (allRejected.length > 0)
      notify.warning(
        `${allRejected.length} ${allRejected.length === 1 ? 'arquivo rejeitado' : 'arquivos rejeitados'}`,
      );
    if (inputRef.current) inputRef.current.value = '';
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(Array.from(e.dataTransfer.files));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        role="button"
        tabIndex={uploading ? -1 : 0}
        aria-disabled={uploading}
        aria-label="Enviar documentos: arraste arquivos ou pressione Enter para escolher"
        onClick={() => !uploading && inputRef.current?.click()}
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="dropzone"
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-surface hover:bg-surface-hover',
          uploading && 'cursor-progress opacity-70',
        )}
      >
        <Upload className="h-6 w-6 text-accent-text" aria-hidden />
        {uploading ? (
          <p className="text-sm font-medium" role="status">
            Enviando {progress.done}/{progress.total}…
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">Arraste arquivos aqui ou clique para escolher</p>
            <p className="text-xs text-muted">
              PDF, Word (.docx), Markdown, texto e imagens (PNG, JPG, WebP) · até 20 MB por arquivo
              · {freeSlots} {freeSlots === 1 ? 'vaga restante' : 'vagas restantes'}
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={LIBRARY_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Selecionar arquivos"
          data-testid="file-input"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => void upload(Array.from(e.target.files ?? []))}
        />
      </div>
      {rejected.length > 0 && (
        <div
          className="rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm"
          role="status"
        >
          <p className="font-medium text-warning">Arquivos não enviados</p>
          <ul className="mt-1 list-disc pl-5 text-fg">
            {rejected.map((r, i) => (
              <li key={`${r.name}-${i}`} className="break-words">
                <span className="font-medium">{r.name}</span> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
