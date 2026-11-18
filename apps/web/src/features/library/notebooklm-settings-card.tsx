import { useQueryClient } from '@tanstack/react-query';
import {
  NOTEBOOKLM_PLANS,
  NOTEBOOKLM_PLAN_LABELS,
  type NotebookLmPlan,
  type NotebookLmSettingsDto,
} from '@thinkflow/shared';
import { Download, LoaderCircle, LogIn, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card } from '../../components/ui/card';
import { Field, Input, Select, Switch, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useNotebookLmLogin, useNotebookLmSettings } from '../../lib/queries';
import { timeAgo } from '../../lib/utils';
import { describeDetection } from './format';

const BASE = '/api/library/notebooklm';
const SETTINGS_KEY = [...keys.libraries, 'notebooklm'] as const;

type Busy = 'save' | 'login' | 'cancel' | 'import' | 'refresh' | 'test' | 'remove' | null;

interface Form {
  enabled: boolean;
  cliCommand: string;
  plan: NotebookLmPlan;
  dailyQueryLimit: number;
  timeoutSec: number;
  fallbackToLocal: boolean;
}

const toForm = (s: NotebookLmSettingsDto): Form => ({
  enabled: s.enabled,
  cliCommand: s.cliCommand,
  plan: s.plan,
  dailyQueryLimit: s.dailyQueryLimit,
  timeoutSec: s.timeoutSec,
  fallbackToLocal: s.fallbackToLocal,
});

export function NotebookLmSettingsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useNotebookLmSettings();
  const login = useNotebookLmLogin();
  const [form, setForm] = useState<Form | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const handledTerminal = useRef(false);

  useEffect(() => {
    if (data) setForm(toForm(data));
  }, [data]);

  // The login runs in a window on the server machine: react once when it ends.
  const loginState = login.data?.state;
  const loginMessage = login.data?.message ?? '';
  useEffect(() => {
    if (loginState === 'waiting') handledTerminal.current = false;
    if ((loginState !== 'done' && loginState !== 'error') || handledTerminal.current) return;
    handledTerminal.current = true;
    if (loginState === 'done') notify.success(loginMessage);
    else notify.error(loginMessage);
    void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    // consume the result so it is not announced again after a reload
    void api
      .del(`${BASE}/login`)
      .then(() => queryClient.invalidateQueries({ queryKey: [...SETTINGS_KEY, 'login'] }))
      .catch(() => undefined);
  }, [loginState, loginMessage, queryClient]);

  if (isLoading || !form || !data)
    return error ? (
      <p className="text-sm text-danger">{errorMessage(error)}</p>
    ) : (
      <p className="text-sm text-muted">Carregando…</p>
    );

  const waiting = loginState === 'waiting';
  const unsupportedHint =
    loginState === 'unsupported'
      ? loginMessage
      : "O servidor não tem tela para abrir o login. Use 'Importar login existente' ou cole o storage_state.json.";
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(data)) || pasted.trim() !== '';
  const limitsValid =
    Number.isInteger(form.dailyQueryLimit) &&
    form.dailyQueryLimit >= 1 &&
    form.dailyQueryLimit <= 10_000 &&
    Number.isInteger(form.timeoutSec) &&
    form.timeoutSec >= 15 &&
    form.timeoutSec <= 300 &&
    form.cliCommand.trim() !== '';

  const refreshSettings = (next: NotebookLmSettingsDto) => {
    queryClient.setQueryData(SETTINGS_KEY, next);
    setForm(toForm(next));
  };

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      // the daily limit is only sent when the user changed it: otherwise it keeps following the plan
      const { dailyQueryLimit, ...rest } = form;
      const next = await api.put<NotebookLmSettingsDto>(BASE, {
        ...rest,
        ...(dailyQueryLimit !== data.dailyQueryLimit ? { dailyQueryLimit } : {}),
        cliCommand: form.cliCommand.trim(),
        ...(pasted.trim() ? { authJson: pasted.trim() } : {}),
      });
      refreshSettings(next);
      setPasted('');
      notify.success(pasted.trim() ? 'Credenciais salvas' : 'Configurações salvas');
    });

  const startLogin = () =>
    run('login', async () => {
      handledTerminal.current = false;
      const status = await api.post<{ state: string }>(`${BASE}/login`);
      queryClient.setQueryData([...SETTINGS_KEY, 'login'], status);
      await queryClient.invalidateQueries({ queryKey: [...SETTINGS_KEY, 'login'] });
    });

  const cancelLogin = () =>
    run('cancel', async () => {
      const status = await api.del<{ state: string }>(`${BASE}/login`);
      queryClient.setQueryData([...SETTINGS_KEY, 'login'], status);
      notify.info('Login cancelado');
    });

  const importLocal = () =>
    run('import', async () => {
      refreshSettings(await api.post<NotebookLmSettingsDto>(`${BASE}/import-local`));
      notify.success('Login existente importado');
    });

  const renew = () =>
    run('refresh', async () => {
      refreshSettings(await api.post<NotebookLmSettingsDto>(`${BASE}/refresh`));
      notify.success('Credenciais renovadas');
    });

  const resetDailyLimit = () =>
    run('save', async () => {
      refreshSettings(await api.put<NotebookLmSettingsDto>(BASE, { dailyQueryLimit: null }));
      notify.success('Limite diário volta a seguir o plano');
    });

  const test = () =>
    run('test', async () => {
      const result = await api.post<{ ok: boolean; message: string }>(`${BASE}/test`);
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      if (result.ok) notify.success(result.message);
      else notify.warning(result.message);
    });

  const remove = () =>
    run('remove', async () => {
      refreshSettings(await api.del<NotebookLmSettingsDto>(`${BASE}/credentials`));
      notify.success('Credenciais removidas');
    });

  const check = data.lastCheck;
  const status = !data.hasCredentials
    ? { tone: 'neutral' as const, label: 'Não conectado' }
    : check?.ok === false
      ? { tone: 'danger' as const, label: 'Sessão com problema' }
      : check?.ok
        ? { tone: 'success' as const, label: 'Conectado' }
        : { tone: 'neutral' as const, label: 'Credenciais salvas' };

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card className="flex flex-col gap-3 border-warning/30 bg-warning-soft p-5">
        <div className="flex items-center gap-2 font-medium text-warning">
          <TriangleAlert className="h-5 w-5" aria-hidden />
          NotebookLM (experimental)
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
          <li>
            Integração <strong>não oficial</strong>: usa APIs não documentadas do Google NotebookLM
            e pode parar de funcionar sem aviso.
          </li>
          <li>
            Os documentos da biblioteca e as perguntas <strong>saem do servidor</strong> e vão para
            a conta Google conectada.
          </li>
          <li>
            Use uma <strong>conta Google separada</strong>, só para isso: a sessão dá acesso à
            conta.
          </li>
          <li>
            A sessão fica criptografada no servidor e expira com o tempo; o Thinkflow tenta
            renová-la sozinho.
          </li>
        </ul>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Conexão com o Google</h2>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>

        <div className="space-y-0.5 text-sm text-muted">
          {data.hasCredentials ? (
            <>
              <p>Credenciais atualizadas {timeAgo(data.credentialsUpdatedAt)}.</p>
              {check && (
                <p className={check.ok ? undefined : 'text-danger'}>
                  Última verificação {timeAgo(check.at)}: {check.message}
                </p>
              )}
            </>
          ) : (
            <p>Entre com a conta Google que vai guardar os documentos.</p>
          )}
        </div>

        {waiting && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 p-3 text-sm"
          >
            <span className="flex items-center gap-2">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              Uma janela de login do Google foi aberta. Conclua o login nela.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void cancelLogin()}
              loading={busy === 'cancel'}
            >
              Cancelar
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void startLogin()}
            loading={busy === 'login'}
            disabled={!data.loginSupported || waiting}
            title={data.loginSupported ? undefined : unsupportedHint}
          >
            <LogIn className="h-4 w-4" aria-hidden />
            Entrar com Google
          </Button>
          {data.localProfileAvailable && (
            <Button
              variant="secondary"
              onClick={() => void importLocal()}
              loading={busy === 'import'}
              disabled={waiting}
              title="Usa o login que você já fez com 'notebooklm login' neste computador"
            >
              <Download className="h-4 w-4" aria-hidden />
              Importar login existente
            </Button>
          )}
          {data.hasCredentials && (
            <>
              <Button
                variant="outline"
                onClick={() => void renew()}
                loading={busy === 'refresh'}
                disabled={waiting}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Renovar agora
              </Button>
              <Button
                variant="outline"
                onClick={() => void test()}
                loading={busy === 'test'}
                disabled={waiting}
              >
                Testar conexão
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    window.confirm(
                      'Remover credenciais: o NotebookLM deixará de funcionar até um novo login. Continuar?',
                    )
                  )
                    void remove();
                }}
                loading={busy === 'remove'}
                disabled={waiting}
              >
                Remover credenciais
              </Button>
            </>
          )}
        </div>
        {!data.loginSupported && <p className="text-xs text-muted">{unsupportedHint}</p>}

        <details className="rounded-xl border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Colar manualmente</summary>
          <div className="mt-3 flex flex-col gap-3">
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>
                Instale a CLI: <code>pip install &quot;notebooklm-py[browser]&quot;</code> e{' '}
                <code>playwright install chromium</code>.
              </li>
              <li>
                Rode <code>notebooklm login</code> em um computador com navegador.
              </li>
              <li>
                Cole abaixo o conteúdo de{' '}
                <code>~/.notebooklm/profiles/default/storage_state.json</code> e clique em Salvar.
              </li>
            </ol>
            <Field
              label="storage_state.json"
              htmlFor="nlm-auth"
              hint={
                data.hasCredentials
                  ? `Credencial salva ${timeAgo(data.credentialsUpdatedAt)} — cole uma nova para substituir.`
                  : 'Fica criptografado no servidor e nunca é exibido novamente.'
              }
            >
              <Textarea
                id="nlm-auth"
                rows={4}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={
                  data.hasCredentials
                    ? 'Credencial salva — cole uma nova para substituir'
                    : '{"cookies": [...], "origins": [...]}'
                }
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
          </div>
        </details>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <h2 className="font-medium">Ajustes</h2>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Ativar o NotebookLM</p>
            <p className="text-xs text-muted">
              {data.hasCredentials
                ? 'Permite criar bibliotecas com o mecanismo NotebookLM.'
                : 'Entre com o Google antes de ativar.'}
            </p>
          </div>
          <Switch
            label="Ativar o NotebookLM"
            checked={form.enabled}
            disabled={!data.hasCredentials}
            onChange={(enabled) => setForm({ ...form, enabled })}
          />
        </div>
        <Field
          label="Plano da conta"
          htmlFor="nlm-plan"
          hint={
            describeDetection(data.detection) ??
            data.detection.unavailableReason ??
            (data.hasCredentials
              ? 'Os limites da conta ainda não foram detectados; use "Testar conexão".'
              : 'Entre com o Google para detectar os limites da conta.')
          }
        >
          <Select
            id="nlm-plan"
            value={form.plan}
            onChange={(e) => setForm({ ...form, plan: e.target.value as NotebookLmPlan })}
          >
            {(Object.keys(NOTEBOOKLM_PLAN_LABELS) as NotebookLmPlan[]).map((plan) => (
              <option key={plan} value={plan}>
                {NOTEBOOKLM_PLAN_LABELS[plan]}
                {plan !== 'auto'
                  ? ` — ${NOTEBOOKLM_PLANS[plan].sourcesPerNotebook} fontes, ${NOTEBOOKLM_PLANS[plan].chatsPerDay} consultas/dia`
                  : ''}
              </option>
            ))}
          </Select>
        </Field>
        <p className="-mt-2 text-xs text-muted">
          Em uso: até {data.sourceLimit} fontes por notebook e {data.dailyQueryLimit} consultas por
          dia. O valor detectado na conta tem prioridade sobre o plano escolhido.
        </p>
        <Field
          label="Comando da CLI"
          htmlFor="nlm-cli"
          hint="Caminho do executável notebooklm (notebooklm-py) neste servidor."
        >
          <Input
            id="nlm-cli"
            value={form.cliCommand}
            onChange={(e) => setForm({ ...form, cliCommand: e.target.value })}
            className="font-mono"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Limite diário de consultas"
            htmlFor="nlm-limit"
            hint={
              <>
                {`Consultas hoje: ${data.queriesToday}/${data.dailyQueryLimit}`}
                {data.dailyQueryLimitCustom ? (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void resetDailyLimit()}
                    >
                      Usar o limite do plano
                    </button>
                  </>
                ) : (
                  ' · segue o plano'
                )}
              </>
            }
          >
            <Input
              id="nlm-limit"
              type="number"
              min={1}
              max={10000}
              value={form.dailyQueryLimit}
              onChange={(e) => setForm({ ...form, dailyQueryLimit: Number(e.target.value) })}
            />
          </Field>
          <Field label="Tempo limite (s)" htmlFor="nlm-timeout" hint="Entre 15 e 300 segundos.">
            <Input
              id="nlm-timeout"
              type="number"
              min={15}
              max={300}
              value={form.timeoutSec}
              onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Usar a busca local se o NotebookLM falhar</p>
            <p className="text-xs text-muted">
              Responde com os trechos do índice local dos mesmos documentos.
            </p>
          </div>
          <Switch
            label="Usar a busca local se o NotebookLM falhar"
            checked={form.fallbackToLocal}
            onChange={(fallbackToLocal) => setForm({ ...form, fallbackToLocal })}
          />
        </div>
        <div>
          <Button
            onClick={() => void save()}
            loading={busy === 'save'}
            disabled={!dirty || !limitsValid}
          >
            Salvar
          </Button>
        </div>
      </Card>
    </div>
  );
}
