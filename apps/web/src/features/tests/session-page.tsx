import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Tabs } from '../../components/ui/card';
import { errorMessage } from '../../lib/api';
import { useTestSession } from '../../lib/queries';
import { StorageNotice } from '../reports/storage-notice';
import { DataTab } from './data-tab';
import { DocumentTab } from './document-tab';
import { DownloadsTab } from './downloads-tab';
import { RecordingControls } from './recording-controls';
import { RecordingNotice } from './recording-notice';
import { StepsTab } from './steps-tab';
import { SessionStateBadge } from './test-state-badge';

type Tab = 'steps' | 'data' | 'downloads' | 'document';
const TABS: Tab[] = ['steps', 'data', 'downloads', 'document'];

export function TestSessionPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : 'steps';
  const { data: session, isLoading, error } = useTestSession(id);

  // a capture made in "Só prints" (button, Ctrl+Shift+S, the browser's toolbar) opens right in the
  // editor of its step, to mark it up and comment it — unless another print is being edited.
  // Recorded steps get an automatic print: those never interrupt the user.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!session) return;
    const ids = Object.values(session.images).map((e) => e.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const added = Object.values(session.images).filter((e) => !seen.current!.has(e.id));
    for (const e of ids) seen.current.add(e);
    const capturing = session.state === 'recording' && session.recordingMode === 'capture';
    if (added.length === 0 || !capturing) return;
    setParams((prev) => (prev.get('edit') ? prev : { edit: added.at(-1)!.stepId }), {
      replace: true,
    });
  }, [session, setParams]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <Link
        to="/tests"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" /> Testes
      </Link>
      {isLoading ? (
        <p className="text-sm text-muted">Carregando sessão…</p>
      ) : error || !session ? (
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar a sessão: {error ? errorMessage(error) : 'não encontrada'}
        </p>
      ) : (
        <>
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight">{session.name}</h1>
                <SessionStateBadge state={session.state} />
              </div>
              <a
                href={session.startUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate font-mono text-xs text-muted hover:text-fg"
              >
                {session.startUrl}
              </a>
            </div>
            <RecordingControls session={session} />
          </div>
          <RecordingNotice />
          <StorageNotice />
          {session.recordingMode === 'capture' && (
            <p
              role="status"
              className="mb-4 rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-text"
            >
              Modo <b>Só prints</b>: navegue à vontade no navegador aberto, nada que você fizer vira
              passo. Use Capturar (ou Ctrl+Shift+S) em cada tela: cada print vira um passo e abre no
              editor para você marcar e comentar.
            </p>
          )}
          {session.warning && (
            <p
              role="status"
              className="mb-4 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning"
            >
              {session.warning}
            </p>
          )}
          <Tabs<Tab>
            value={tab}
            onChange={(next) => setParams(next === 'steps' ? {} : { tab: next }, { replace: true })}
            items={[
              { value: 'steps', label: 'Passos', count: session.stepCount },
              // a session of prints has nothing to replay
              ...(session.mode === 'capture'
                ? []
                : [{ value: 'data' as const, label: 'Dados e replay' }]),
              { value: 'downloads', label: 'Downloads', count: session.downloadCount },
              { value: 'document', label: 'Documento' },
            ]}
          />
          {tab === 'steps' && <StepsTab session={session} />}
          {tab === 'data' && session.mode !== 'capture' && <DataTab session={session} />}
          {tab === 'downloads' && <DownloadsTab session={session} />}
          {tab === 'document' && <DocumentTab session={session} />}
        </>
      )}
    </div>
  );
}
