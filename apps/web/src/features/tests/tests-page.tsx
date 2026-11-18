import { useQueryClient } from '@tanstack/react-query';
import type { TestSessionSummaryDto } from '@thinkflow/shared';
import { Camera, ExternalLink, FlaskConical, ListChecks, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { Card, EmptyState, PageHeader } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useTestSessions } from '../../lib/queries';
import { timeAgo } from '../../lib/utils';
import { StorageNotice } from '../reports/storage-notice';
import { NewTestSessionDialog } from './new-session-dialog';
import { RecordingNotice } from './recording-notice';
import { RunStatusBadge, SessionStateBadge } from './test-state-badge';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function SessionRow({ session: s }: { session: TestSessionSummaryDto }) {
  const queryClient = useQueryClient();
  const remove = async () => {
    try {
      await api.del(`/api/tests/sessions/${s.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.tests });
      notify.success('Sessão excluída');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };
  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <SessionStateBadge state={s.state} />
          {s.lastRun && <RunStatusBadge status={s.lastRun.status} />}
          <span className="text-xs text-subtle">{timeAgo(s.updatedAt)}</span>
        </div>
        <Link
          to={`/tests/${s.id}`}
          className="mt-1.5 block truncate font-medium hover:text-accent-text"
        >
          {s.name}
        </Link>
        <p className="truncate font-mono text-xs text-muted">{s.startUrl}</p>
        <p className="mt-1 flex gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <ListChecks className="h-3.5 w-3.5" aria-hidden />
            {plural(s.stepCount, 'passo', 'passos')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Camera className="h-3.5 w-3.5" aria-hidden />
            {plural(s.imageCount, 'print', 'prints')}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Link to={`/tests/${s.id}`} aria-label={`Abrir ${s.name}`}>
          <Button variant="ghost" size="sm" tabIndex={-1}>
            <ExternalLink className="h-4 w-4" /> Abrir
          </Button>
        </Link>
        <ConfirmButton label={`Excluir ${s.name}`} onConfirm={() => void remove()}>
          <Trash2 className="h-4 w-4" />
        </ConfirmButton>
      </div>
    </Card>
  );
}

export function TestsPage() {
  const [creating, setCreating] = useState(false);
  const { data: sessions, isLoading, error } = useTestSessions();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Testes"
        description="Grave o teste no navegador, capture e anote evidências, reexecute com outros dados e copie a documentação pronta."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Nova sessão
          </Button>
        }
      />
      <RecordingNotice />
      <StorageNotice />
      {isLoading ? (
        <p className="text-sm text-muted">Carregando sessões…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar as sessões: {errorMessage(error)}
        </p>
      ) : !sessions || sessions.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="h-6 w-6" />}
          title="Nenhuma sessão de teste ainda"
          description="Informe a URL, navegue normalmente e o Thinkflow registra os passos, os prints e os dados usados."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Nova sessão
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((s) => (
            <li key={s.id}>
              <SessionRow session={s} />
            </li>
          ))}
        </ul>
      )}
      {creating && <NewTestSessionDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
