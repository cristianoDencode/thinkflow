import { isStructuralStep, type TestSessionDto } from '@thinkflow/shared';
import {
  Camera,
  Circle,
  CircleCheck,
  LayoutTemplate,
  Link2,
  Pause,
  Play,
  Square,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';
import { useTestSupport } from '../../lib/queries';
import { useSessionAction } from './use-session-action';

/**
 * The mode is chosen once, when the recording starts: "Gravar passos" (every action becomes a step
 * with an automatic print) or "Só prints" (nothing becomes a step, each manual print does). It is
 * never switched during a recording, and a session that already has steps continues in its own.
 */
export function RecordingControls({ session }: { session: TestSessionDto }) {
  const { data: support } = useTestSupport();
  const { busy, run } = useSessionAction(session.id);
  const base = `/api/tests/sessions/${session.id}/record`;
  const supported = support?.recording.supported ?? true;

  if (session.state === 'idle') {
    const unsupportedTitle = supported ? undefined : support?.recording.message;
    // steps (notes aside) fix the mode: only a session without any can still choose
    const choose = !session.definition.steps.some((s) => !isStructuralStep(s));
    if (!choose) {
      const capture = session.mode === 'capture';
      return (
        <div className="flex flex-wrap gap-2">
          <Button
            loading={busy === 'start'}
            disabled={!supported || busy !== null}
            title={
              unsupportedTitle ??
              (capture
                ? 'Continua no modo Só prints: cada print que você tirar vira um passo'
                : 'Continua gravando passos, cada um com o print da tela')
            }
            onClick={() =>
              void run(
                'start',
                () => api.post(`${base}/start`),
                capture
                  ? 'Navegador aberto: navegue e capture as telas'
                  : 'Navegador aberto: faça o teste nele',
              )
            }
          >
            {capture ? (
              <Camera className="h-4 w-4" />
            ) : (
              <Circle className="h-4 w-4 fill-current text-danger" />
            )}
            Continuar gravação
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          loading={busy === 'start'}
          disabled={!supported || busy !== null}
          title={
            unsupportedTitle ??
            'Cada clique, preenchimento e navegação vira um passo, com o print automático da tela'
          }
          onClick={() =>
            void run(
              'start',
              () => api.post(`${base}/start`, { mode: 'record' }),
              'Navegador aberto: faça o teste nele',
            )
          }
        >
          <Circle className="h-4 w-4 fill-current text-danger" />
          Gravar passos
        </Button>
        <Button
          variant="soft"
          loading={busy === 'start-capture'}
          disabled={!supported || busy !== null}
          title={
            unsupportedTitle ??
            'Navegue à vontade: nada vira passo, só os prints que você tirar (cada um vira um passo)'
          }
          onClick={() =>
            void run(
              'start-capture',
              () => api.post(`${base}/start`, { mode: 'capture' }),
              'Navegador aberto: navegue e capture as telas',
            )
          }
        >
          <Camera className="h-4 w-4" /> Só prints
        </Button>
      </div>
    );
  }
  if (session.state === 'running') return null;
  // the screen the person is on becomes an editable prototype ("Só prints" only; the session goes on)
  const prototype = (
    <Button
      variant="secondary"
      loading={busy === 'prototype'}
      title="Salva a tela atual do navegador como protótipo editável (campos, tabelas e dados pessoais saem sem dados, por LGPD). Também pelo botão Protótipo no navegador aberto"
      onClick={() =>
        void run('prototype', () => api.post(`${base}/prototype`, {}), 'Protótipo salvo')
      }
    >
      <LayoutTemplate className="h-4 w-4" /> Protótipo
    </Button>
  );
  const stop = (
    <Button
      variant="danger"
      loading={busy === 'stop'}
      onClick={() => void run('stop', () => api.post(`${base}/stop`), 'Gravação encerrada')}
    >
      <Square className="h-4 w-4" /> Parar
    </Button>
  );
  if (session.recordingMode === 'capture') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={busy === 'capture'}
          title="Também pelo botão Capturar ou Ctrl+Shift+S no navegador aberto"
          onClick={() =>
            void run(
              'capture',
              () => api.post(`/api/tests/sessions/${session.id}/capture`),
              'Tela capturada',
            )
          }
        >
          <Camera className="h-4 w-4" /> Capturar
        </Button>
        {prototype}
        {stop}
      </div>
    );
  }
  const paused = session.state === 'paused';
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        loading={busy === 'verify'}
        title="Tira um print da tela inteira e o registra como uma verificação (a gravação continua)"
        onClick={() =>
          void run('verify', () => api.post(`${base}/checkpoint`), 'Verificação adicionada')
        }
      >
        <CircleCheck className="h-4 w-4" /> Verificar
      </Button>
      <Button
        variant="secondary"
        loading={busy === 'url'}
        title="Verifica que a URL da página atual contém o caminho dela"
        onClick={() =>
          void run(
            'url',
            () => api.post(`${base}/assert-page`, { type: 'urlContains' }),
            'Verificação de URL adicionada',
          )
        }
      >
        <Link2 className="h-4 w-4" /> Verificar URL
      </Button>
      <Button
        variant="secondary"
        loading={busy === 'pause'}
        onClick={() => void run('pause', () => api.post(`${base}/pause`, { paused: !paused }))}
      >
        {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        {paused ? 'Retomar' : 'Pausar'}
      </Button>
      {stop}
    </div>
  );
}
