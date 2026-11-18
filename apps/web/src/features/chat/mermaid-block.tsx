import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hashDiagram } from '@thinkflow/shared';
import { Code2, Copy, Download, Eye, LoaderCircle, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { notify } from '../../lib/notify';
import { useTheme } from '../../lib/theme';
import { Button } from '../../components/ui/button';
import { useDiagramContext } from './diagram-context';

const importMermaid = () => import('mermaid');
type MermaidApi = Awaited<ReturnType<typeof importMermaid>>['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;
/** Mermaid is large: it is only fetched (as its own chunk) when a diagram is first drawn. */
export function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= importMermaid().then((m) => m.default);
  mermaidPromise.catch(() => {
    mermaidPromise = null;
  });
  return mermaidPromise;
}

let renderSeq = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

/** Draws `code` (rejects with the parser's message). Renders are serialised: mermaid is global state. */
function renderDiagram(code: string, dark: boolean): Promise<string> {
  const run = async (): Promise<string> => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    await mermaid.parse(code);
    const id = `tf-mmd-${++renderSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } finally {
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const result = renderQueue.then(run, run);
  renderQueue = result.catch(() => undefined);
  return result;
}

const repairInFlight = new Map<string, Promise<string | null>>();

function requestRepair(
  code: string,
  error: string,
  model: string,
  messageId?: string,
): Promise<string | null> {
  const key = `${messageId ?? ''}:${hashDiagram(code)}`;
  let pending = repairInFlight.get(key);
  if (!pending) {
    pending = api
      .post<{ code: string | null }>('/api/diagrams/repair', {
        code,
        error: error.slice(0, 2_000),
        model,
        ...(messageId ? { messageId } : {}),
      })
      .then((r) => r.code)
      .catch(() => null)
      .finally(() => {
        setTimeout(() => repairInFlight.delete(key), 0);
      });
    repairInFlight.set(key, pending);
  }
  return pending;
}

type State =
  { kind: 'loading' } | { kind: 'repairing' } | { kind: 'ok'; svg: string } | { kind: 'failed' };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function MermaidBlock({ code, streaming = false }: { code: string; streaming?: boolean }) {
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const { messageId, model, repairs } = useDiagramContext();
  const hash = useMemo(() => hashDiagram(code), [code]);
  const cached = repairs?.[hash];
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [showCode, setShowCode] = useState(false);
  const shownCode = useRef(code);

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    shownCode.current = code;
    const done = (svg: string, source: string) => {
      if (cancelled) return;
      shownCode.current = source;
      setState({ kind: 'ok', svg });
    };
    const fail = () => !cancelled && setState({ kind: 'failed' });

    void (async () => {
      let error: string;
      try {
        done(await renderDiagram(code, dark), code);
        return;
      } catch (err) {
        error = messageOf(err);
      }
      if (cancelled) return;
      let repaired: string | null | undefined = cached;
      if (repaired === undefined) {
        if (!model) return fail();
        setState({ kind: 'repairing' });
        repaired = await requestRepair(code, error, model, messageId);
      }
      if (cancelled) return;
      if (!repaired) return fail();
      try {
        done(await renderDiagram(repaired, dark), repaired);
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, streaming, dark, cached, model, messageId]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shownCode.current);
      notify.success('Código do diagrama copiado');
    } catch {
      notify.error('Não foi possível copiar');
    }
  };

  const downloadSvg = () => {
    if (state.kind !== 'ok') return;
    const url = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagrama-${hash}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const codeView = (
    <pre data-testid="mermaid-code">
      <code>{streaming || state.kind === 'failed' ? code : shownCode.current}</code>
    </pre>
  );

  if (streaming) return <div className="my-3">{codeView}</div>;

  return (
    <figure className="my-3 rounded-xl border border-border bg-bg-elevated/60 p-3">
      {state.kind === 'failed' ? (
        <>
          {codeView}
          <p
            role="status"
            className="mt-2 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>Diagrama inválido: não foi possível desenhá-lo; mostrando o código.</span>
          </p>
        </>
      ) : state.kind === 'ok' ? (
        <>
          {showCode ? (
            codeView
          ) : (
            <div
              className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
              role="img"
              aria-label="Diagrama"
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShowCode((v) => !v)}>
              {showCode ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              {showCode ? 'Ver diagrama' : 'Ver código'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copy()}>
              <Copy className="h-3.5 w-3.5" /> Copiar
            </Button>
            <Button size="sm" variant="ghost" onClick={downloadSvg}>
              <Download className="h-3.5 w-3.5" /> Baixar SVG
            </Button>
          </div>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          {state.kind === 'repairing' ? 'Corrigindo diagrama…' : 'Desenhando diagrama…'}
        </p>
      )}
    </figure>
  );
}

class DiagramBoundary extends Component<
  { code: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="my-3">
        <pre>
          <code>{this.props.code}</code>
        </pre>
        <p role="status" className="text-sm text-warning">
          Diagrama inválido: não foi possível desenhá-lo; mostrando o código.
        </p>
      </div>
    );
  }
}

export function SafeMermaidBlock(props: { code: string; streaming?: boolean }) {
  return (
    <DiagramBoundary code={props.code}>
      <MermaidBlock {...props} />
    </DiagramBoundary>
  );
}
