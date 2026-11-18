import type { LibraryEngine, LibrarySearchResultDto } from '@thinkflow/shared';
import { Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card } from '../../components/ui/card';
import { Input } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys } from '../../lib/queries';

export function SearchPreview({
  libraryId,
  engine = 'local',
}: {
  libraryId: string;
  engine?: LibraryEngine;
}) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LibrarySearchResultDto | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    try {
      setResult(
        await api.get<LibrarySearchResultDto>(
          `/api/libraries/${libraryId}/search?q=${encodeURIComponent(query)}&k=5`,
        ),
      );
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      // the NotebookLM daily counter changed
      if (engine === 'notebooklm') void queryClient.invalidateQueries({ queryKey: keys.libraries });
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="font-medium">Testar busca</h2>
        <p className="text-sm text-muted">
          {engine === 'notebooklm'
            ? 'Faz a pergunta ao NotebookLM, como a IA faria (usa a cota diária e pode levar alguns segundos).'
            : 'Veja quais trechos a IA receberia para uma pergunta.'}
        </p>
      </div>
      <form onSubmit={(e) => void submit(e)} className="flex gap-2">
        <Input
          aria-label="Pergunta de teste"
          placeholder="Ex.: qual o prazo de entrega?"
          value={q}
          maxLength={500}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" loading={busy} disabled={!q.trim()}>
          <Search className="h-4 w-4" /> Buscar
        </Button>
      </form>
      {result &&
        (result.hits.length === 0 && !(engine === 'notebooklm' && result.toolOutput) ? (
          <p className="text-sm text-muted">Nenhum trecho relevante encontrado.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {result.hits.map((hit, i) => (
              <li key={`${hit.documentId}-${i}`} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-medium text-fg">{hit.documentName}</span>
                  {hit.heading && <span>· {hit.heading}</span>}
                  {hit.pageFrom !== null && (
                    <Badge>
                      {hit.pageTo !== null && hit.pageTo !== hit.pageFrom
                        ? `págs. ${hit.pageFrom}–${hit.pageTo}`
                        : `pág. ${hit.pageFrom}`}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap break-words">{hit.excerpt}</p>
              </li>
            ))}
          </ul>
        ))}
      {result && (
        <details
          open={engine === 'notebooklm'}
          className="rounded-xl border border-border bg-surface-2 p-3"
        >
          <summary className="cursor-pointer text-sm font-medium">Texto que a IA recebe</summary>
          <pre className="mt-2 max-h-80 overflow-auto text-xs whitespace-pre-wrap break-words">
            {result.toolOutput}
          </pre>
        </details>
      )}
    </Card>
  );
}
