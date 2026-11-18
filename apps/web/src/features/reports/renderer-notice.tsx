import { TriangleAlert } from 'lucide-react';
import { useReportRenderer } from '../../lib/queries';

/** Banner shown when the server cannot render PDFs/diagrams (Chromium missing). */
export function RendererNotice() {
  const { data } = useReportRenderer();
  if (!data || data.pdf) return null;
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-xl border border-transparent bg-warning-soft px-4 py-3 text-sm text-warning"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">PDF indisponível neste servidor</p>
        <p className="mt-0.5 text-fg">
          {data.reason ?? 'O Chromium não foi encontrado.'} Os relatórios continuam disponíveis em
          Markdown e HTML. Para habilitar o PDF, instale o Chromium (por exemplo{' '}
          <code className="rounded bg-surface-2 px-1">pnpm exec playwright install chromium</code>)
          ou informe o caminho em Configurações de relatórios (<code>chromiumPath</code>).
        </p>
      </div>
    </div>
  );
}
