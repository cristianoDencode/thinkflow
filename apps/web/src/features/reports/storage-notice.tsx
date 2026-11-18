import { TriangleAlert } from 'lucide-react';
import { useStorageStatus } from '../../lib/queries';

/** Banner shown when document storage is down or has uploads waiting. */
export function StorageNotice() {
  const { data } = useStorageStatus();
  if (!data) return null;
  const down = !data.available;
  if (!down && data.pendingUploads === 0) return null;
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-xl border border-transparent bg-warning-soft px-4 py-3 text-sm text-warning"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">
          {down ? 'Armazenamento de documentos indisponível' : 'Documentos aguardando envio'}
        </p>
        <p className="mt-0.5 text-fg">
          {down && (data.reason ?? 'Não foi possível acessar o armazenamento.')}
          {down && ' '}
          {data.pendingUploads > 0
            ? `${data.pendingUploads} ${data.pendingUploads === 1 ? 'documento será enviado' : 'documentos serão enviados'} assim que o armazenamento voltar. `
            : ''}
          Os relatórios continuam disponíveis, mas downloads de documentos já armazenados podem
          falhar. Veja Configurações &gt; Armazenamento de documentos.
        </p>
      </div>
    </div>
  );
}
