import { useQueryClient } from '@tanstack/react-query';
import type {
  CtAssistantDocument,
  CtAssistantPatch,
  CtOneDriveResultDto,
  CtStateDto,
  TestSessionDto,
} from '@thinkflow/shared';
import {
  ChevronDown,
  ClipboardCopy,
  Cloud,
  ExternalLink,
  FileArchive,
  FileCode2,
  FileDown,
  FileText,
  RefreshCw,
  Save,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys } from '../../lib/queries';
import { useOneDriveStatus } from '../integrations/onedrive-queries';
import { CtAssistantPanel } from './ct-assistant-panel';
import { CtFormFields } from './ct-form';
import { CtModelSelector } from './ct-model-selector';
import { ctBase, ctKey, formKey, toForm, toPayload, useCtState, type CtForm } from './ct-state';
import { useSessionAction } from './use-session-action';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(await failureMessage(res));
  return res.text();
}

async function failureMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // not JSON: fall through
  }
  return `Erro ${res.status} ao gerar o documento`;
}

/** Name from `Content-Disposition` (`filename*=` first), else the fallback. */
function fileNameOf(res: Response, fallback: string): string {
  const header = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      // use the plain name
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

/** Downloads through fetch so a failure (PDF without Chromium, say) shows its message. */
async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(await failureMessage(res));
  const blob = await res.blob();
  const link = document.createElement('a');
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileNameOf(res, fallbackName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/**
 * Rich text for Word / Google Docs / Confluence (HTML with embedded images) plus a plain-text
 * flavor, so editors that only take text still get something readable.
 */
export async function copyRich(html: string, markdown: string): Promise<'rich' | 'text'> {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard && typeof ClipboardItem !== 'undefined' && 'write' in clipboard) {
    await clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
      }),
    ]);
    return 'rich';
  }
  if (!clipboard) throw new Error('A área de transferência não está disponível neste navegador.');
  await clipboard.writeText(markdown);
  return 'text';
}

/** The old evidence document (step by step with prints) and the Playwright script. */
function OtherFormats({ session }: { session: TestSessionDto }) {
  const base = `/api/tests/sessions/${session.id}/document`;
  const [busy, setBusy] = useState<string | null>(null);

  const copy = async (kind: 'rich' | 'md') => {
    setBusy(kind);
    try {
      const markdown = await fetchText(`${base}?format=md&inline=1`);
      if (kind === 'md') {
        await navigator.clipboard.writeText(markdown);
        notify.success('Markdown copiado (imagens embutidas)');
      } else {
        const how = await copyRich(await fetchText(`${base}?format=html`), markdown);
        notify.success(
          how === 'rich'
            ? 'Evidência copiada: cole no Word, Google Docs ou Confluence'
            : 'Copiado como texto',
        );
      }
    } catch (err) {
      notify.error(`${errorMessage(err)} Use "Baixar .zip".`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="group relative">
      <summary className="inline-flex h-10 cursor-pointer list-none items-center gap-2 rounded-xl border border-border bg-surface-2 px-4 text-sm font-medium hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
        Outros formatos <ChevronDown className="h-4 w-4" />
      </summary>
      <div className="absolute left-0 z-20 mt-1 flex w-72 flex-col gap-1 rounded-xl border border-border bg-bg-elevated p-2 shadow-lg">
        <p className="px-2 pb-1 text-xs text-muted">
          Evidência passo a passo (todos os passos, com os prints incluídos).
        </p>
        <Button
          variant="ghost"
          className="justify-start"
          loading={busy === 'rich'}
          onClick={() => void copy('rich')}
        >
          <ClipboardCopy className="h-4 w-4" /> Copiar para Word/Docs
        </Button>
        <Button
          variant="ghost"
          className="justify-start"
          loading={busy === 'md'}
          onClick={() => void copy('md')}
        >
          <FileText className="h-4 w-4" /> Copiar Markdown
        </Button>
        <a href={`${base}?format=zip`} download className="inline-flex">
          <Button variant="ghost" className="w-full justify-start" tabIndex={-1}>
            <FileArchive className="h-4 w-4" /> Baixar .zip
          </Button>
        </a>
        {session.mode !== 'capture' && (
          <a href={`${base}?format=spec`} download className="inline-flex">
            <Button variant="ghost" className="w-full justify-start" tabIndex={-1}>
              <FileCode2 className="h-4 w-4" /> Baixar script Playwright
            </Button>
          </a>
        )}
      </div>
    </details>
  );
}

export function DocumentTab({ session }: { session: TestSessionDto }) {
  const queryClient = useQueryClient();
  const base = ctBase(session.id);
  const { data: ct, error: loadError } = useCtState(session.id);
  const onedrive = useOneDriveStatus();
  const { run: runSession } = useSessionAction(session.id);
  const idle = session.state === 'idle';

  // the form starts from the server copy and keeps local edits until saved
  const server = useMemo(() => (ct ? toForm(ct) : null), [ct]);
  const serverKey = formKey(server);
  const [draft, setDraft] = useState<CtForm | null>(null);
  const [baseKey, setBaseKey] = useState<string | null>(null);
  if (server && serverKey !== baseKey) {
    if (draft === null || formKey(draft) === baseKey) {
      setDraft(server);
    } else {
      // steps changed under unsaved edits: follow the new use-case list, keep what was typed
      const typed = new Map(draft.useCases.map((uc) => [uc.stepId, uc]));
      setDraft({
        fields: draft.fields,
        useCases: server.useCases.map((uc) => {
          const mine = typed.get(uc.stepId);
          return mine ? { ...uc, title: mine.title, status: mine.status } : uc;
        }),
      });
    }
    setBaseKey(serverKey);
  }
  const dirty = draft !== null && formKey(draft) !== serverKey;

  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [uploaded, setUploaded] = useState<CtOneDriveResultDto | null>(null);

  const previewSrc = `${base}/preview?v=${session.updatedAt}-${Object.values(session.images)
    .map((e) => e.updatedAt)
    .join(',')}-${refresh}`;

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setBusy('save');
    try {
      const saved = await api.put<CtStateDto>(base, toPayload(draft));
      queryClient.setQueryData(ctKey(session.id), saved);
      const next = toForm(saved);
      setDraft(next);
      setBaseKey(formKey(next));
      await queryClient.invalidateQueries({ queryKey: keys.tests });
      setRefresh((n) => n + 1);
      notify.success('Documento salvo');
      return true;
    } catch (err) {
      notify.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** Exports use the saved document: unsaved edits are saved first. */
  const action = async (name: string, fn: () => Promise<void>) => {
    if (dirty && !(await save())) return;
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copyPlano = () =>
    action('copy', async () => {
      const [html, text] = await Promise.all([
        fetchText(`${base}/clipboard`),
        fetchText(`${base}/clipboard?format=text`),
      ]);
      const how = await copyRich(html, text);
      notify.success(
        how === 'rich'
          ? 'Plano de Teste copiado: cole no Word ou no Confluence'
          : 'Plano de Teste copiado como texto',
      );
    });

  const sendToOneDrive = () =>
    action('onedrive', async () => {
      const result = await api.post<CtOneDriveResultDto>(`${base}/onedrive`);
      setUploaded(result);
      window.open(result.webUrl, '_blank', 'noopener,noreferrer');
      notify.success(`Enviado ao OneDrive: ${result.name}`);
    });

  // the AI assistant: title / análise / contexto replace the form fields (saved with "Salvar");
  // use-case items are the comments of the steps that produced them, saved on the step right away
  const assistantDocument = useMemo<CtAssistantDocument | null>(
    () =>
      ct && draft
        ? {
            title: draft.fields.title,
            analysisTitle: draft.fields.analysisTitle,
            context: draft.fields.context,
            useCases: ct.document.useCases,
          }
        : null,
    [ct, draft],
  );
  const applyPatch = (patch: CtAssistantPatch) => {
    if (!draft || !ct) return;
    setDraft({
      ...draft,
      fields: {
        ...draft.fields,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.analysisTitle !== undefined ? { analysisTitle: patch.analysisTitle } : {}),
        ...(patch.context !== undefined ? { context: patch.context } : {}),
      },
    });
    const edits: { stepId: string; text: string }[] = [];
    for (const useCase of patch.useCases ?? []) {
      for (const item of useCase.items) {
        const stepId = ct.itemStepIds[useCase.index]?.[item.index];
        if (stepId) edits.push({ stepId, text: item.text });
      }
    }
    if (edits.length > 0) {
      void runSession(
        'assistant',
        async () => {
          for (const edit of edits) {
            await api.patch(`/api/tests/sessions/${session.id}/steps/${edit.stepId}`, {
              comment: edit.text,
            });
          }
        },
        edits.length === 1
          ? 'Comentário do passo atualizado'
          : 'Comentários dos passos atualizados',
      );
    }
  };

  const connected = onedrive.data?.state === 'connected';
  const onedriveHint = onedrive.isLoading
    ? 'Verificando o OneDrive…'
    : onedrive.data?.state === 'reconnect_required'
      ? 'A conexão com o OneDrive expirou.'
      : 'OneDrive não conectado.';

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-danger">
        Não foi possível montar o documento: {errorMessage(loadError)}
      </p>
    );
  }
  if (!ct || !draft) return <p className="text-sm text-muted">Montando o documento…</p>;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted">
          Documento <b>Caso de Teste CT</b>: o cabeçalho e os textos abaixo, mais os casos de uso
          montados com os comentários e prints da aba Passos ({ct.imageCount}{' '}
          {ct.imageCount === 1 ? 'print' : 'prints'}).
        </p>
        <CtModelSelector
          sessionId={session.id}
          modelId={ct.modelId}
          disabled={!idle || busy !== null}
          onChanged={() => setRefresh((n) => n + 1)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            loading={busy === 'save'}
            disabled={!dirty || !idle || busy !== null}
            onClick={() => void save()}
          >
            <Save className="h-4 w-4" /> Salvar
          </Button>
          <Button
            loading={busy === 'docx'}
            disabled={busy !== null}
            onClick={() =>
              void action('docx', () => downloadFile(`${base}/docx`, 'caso-de-teste.docx'))
            }
          >
            <FileDown className="h-4 w-4" /> Baixar .docx
          </Button>
          <Button
            variant="secondary"
            loading={busy === 'pdf'}
            disabled={busy !== null}
            onClick={() =>
              void action('pdf', () => downloadFile(`${base}/pdf`, 'caso-de-teste.pdf'))
            }
          >
            <FileDown className="h-4 w-4" /> Baixar PDF
          </Button>
          <Button
            variant="secondary"
            loading={busy === 'copy'}
            disabled={busy !== null}
            onClick={() => void copyPlano()}
          >
            <ClipboardCopy className="h-4 w-4" /> Copiar Plano de Teste
          </Button>
          <Button
            variant="soft"
            loading={busy === 'onedrive'}
            disabled={!connected || busy !== null}
            title={connected ? undefined : onedriveHint}
            onClick={() => void sendToOneDrive()}
          >
            <Cloud className="h-4 w-4" /> Enviar ao OneDrive
          </Button>
          <OtherFormats session={session} />
          <Button
            variant="ghost"
            aria-label="Atualizar pré-visualização"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        {!connected && !onedrive.isLoading && (
          <p className="text-xs text-muted">
            {onedriveHint} Para enviar o .docx ao Word Online, conecte em{' '}
            <Link to="/settings" className="font-medium text-accent-text underline">
              Configurações › OneDrive
            </Link>
            .
          </p>
        )}
        {uploaded && (
          <p role="status" className="text-sm">
            Enviado ao OneDrive:{' '}
            <a
              href={uploaded.webUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 font-medium text-accent-text underline"
            >
              {uploaded.name} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </p>
        )}
        {dirty && (
          <p role="status" className="text-xs text-warning">
            Alterações não salvas: salve para atualizar a pré-visualização (os botões acima salvam
            antes de gerar).
          </p>
        )}
        {!idle && (
          <p role="status" className="text-xs text-warning">
            Pare a gravação ou a execução para editar o documento.
          </p>
        )}
        {ct.warnings.map((warning) => (
          <p key={warning} role="status" className="text-xs text-warning">
            {warning}
          </p>
        ))}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <CtFormFields form={draft} onChange={setDraft} disabled={!idle} />
          {assistantDocument && (
            <CtAssistantPanel
              sessionId={session.id}
              document={assistantDocument}
              onApply={applyPatch}
            />
          )}
        </div>
        <iframe
          title="Pré-visualização do documento CT"
          // same origin so the prints (authenticated route) load; nothing in it can run scripts
          sandbox="allow-same-origin"
          src={previewSrc}
          className="h-[80vh] w-full rounded-xl border border-border bg-white lg:sticky lg:top-4"
        />
      </div>
    </div>
  );
}
