import {
  isStructuralStep,
  SECRET_MARKER,
  type TestDataSet,
  type TestDownloadDto,
  type TestParameter,
  type TestRunDto,
  type TestSessionDto,
  stepTitle,
} from '@thinkflow/shared';
import {
  ChevronDown,
  ChevronRight,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { Input, Select, Switch } from '../../components/ui/form';
import { api } from '../../lib/api';
import { useTestDownloads } from '../../lib/queries';
import { cn, formatTime } from '../../lib/utils';
import { DownloadLink } from './downloads-tab';
import { formatFileSize } from './format';
import { RunStatusBadge } from './test-state-badge';
import { useScrollToHash } from './use-scroll-to-hash';
import { useSessionAction } from './use-session-action';

const isMarker = (v: unknown) => typeof v === 'object' && v !== null;

/**
 * What goes to the server: a secret cleared after typing keeps the stored one (marker), a blank
 * value in another set means "same as recorded" (left out), the recorded set keeps blanks.
 */
export function cleanValues(
  ds: TestDataSet,
  index: number,
  parameters: TestParameter[],
  original: TestDataSet[],
): TestDataSet {
  const before = original.find((d) => d.id === ds.id)?.values ?? {};
  const values: TestDataSet['values'] = {};
  for (const p of parameters) {
    const v = ds.values[p.id];
    if (v === undefined) continue;
    if (v === '') {
      if (p.secret && isMarker(before[p.id])) values[p.id] = { ...SECRET_MARKER };
      else if (index === 0 && !p.secret) values[p.id] = '';
      continue;
    }
    values[p.id] = v;
  }
  return { ...ds, name: ds.name.trim() || `Conjunto ${index + 1}`, values };
}
const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function DataTable({ session }: { session: TestSessionDto }) {
  const def = session.definition;
  const { busy, run } = useSessionAction(session.id);
  const [parameters, setParameters] = useState<TestParameter[]>(def.parameters);
  const [dataSets, setDataSets] = useState<TestDataSet[]>(def.dataSets);
  const editable = session.state === 'idle';
  const serverVersion = JSON.stringify([def.parameters, def.dataSets]);
  // a new recording (or another tab) changed the data: start again from the server copy
  useEffect(() => {
    setParameters(def.parameters);
    setDataSets(def.dataSets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverVersion]);
  const dirty = JSON.stringify([parameters, dataSets]) !== serverVersion;

  if (def.parameters.length === 0) {
    return (
      <EmptyState
        icon={<Plus className="h-6 w-6" />}
        title="Nenhum dado gravado"
        description="Cada campo preenchido durante a gravação vira um dado aqui. Crie conjuntos com outros valores (e-mail inválido, CPF de outro titular…) e reexecute o teste com eles."
      />
    );
  }

  const setParam = (i: number, patch: Partial<TestParameter>) =>
    setParameters((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const setValue = (dsId: string, paramId: string, value: string) =>
    setDataSets((all) =>
      all.map((d) => (d.id === dsId ? { ...d, values: { ...d.values, [paramId]: value } } : d)),
    );
  const addSet = () =>
    setDataSets((all) => [...all, { id: newId(), name: `Conjunto ${all.length + 1}`, values: {} }]);

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Dado</th>
            <th className="px-3 py-2 font-medium">Nome no script</th>
            <th className="px-3 py-2 font-medium">Sigiloso</th>
            {dataSets.map((ds, i) => (
              <th key={ds.id} className="min-w-44 px-3 py-2 font-medium">
                <div className="flex items-center gap-1">
                  <Input
                    aria-label={`Nome do conjunto ${i + 1}`}
                    className="h-8"
                    value={ds.name}
                    disabled={!editable || i === 0}
                    maxLength={200}
                    onChange={(e) =>
                      setDataSets((all) =>
                        all.map((d) => (d.id === ds.id ? { ...d, name: e.target.value } : d)),
                      )
                    }
                  />
                  {i > 0 && editable && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remover conjunto ${ds.name}`}
                      onClick={() => setDataSets((all) => all.filter((d) => d.id !== ds.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {parameters.map((p, i) => (
            <tr key={p.id} className="border-t border-border">
              <td className="px-3 py-2">
                <Input
                  aria-label={`Rótulo do dado ${i + 1}`}
                  className="h-8"
                  value={p.label}
                  disabled={!editable}
                  maxLength={200}
                  onChange={(e) => setParam(i, { label: e.target.value })}
                />
              </td>
              <td className="px-3 py-2">
                <Input
                  aria-label={`Nome no script do dado ${i + 1}`}
                  className="h-8 font-mono text-xs"
                  value={p.name}
                  disabled={!editable}
                  maxLength={50}
                  onChange={(e) =>
                    setParam(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })
                  }
                />
              </td>
              <td className="px-3 py-2">
                <Switch
                  checked={p.secret}
                  disabled={!editable}
                  onChange={(secret) => setParam(i, { secret })}
                  label={`Dado ${p.label} é sigiloso`}
                />
              </td>
              {dataSets.map((ds, j) => {
                const v = ds.values[p.id];
                const kept = isMarker(v);
                return (
                  <td key={ds.id} className="px-3 py-2">
                    <Input
                      aria-label={`${p.label} em ${ds.name}`}
                      className="h-8"
                      type={p.secret ? 'password' : 'text'}
                      autoComplete="off"
                      disabled={!editable}
                      value={typeof v === 'string' ? v : ''}
                      placeholder={
                        kept ? '•••••• (guardado)' : j > 0 ? 'igual ao gravado' : undefined
                      }
                      onChange={(e) => setValue(ds.id, p.id, e.target.value)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border p-3">
          <Button variant="secondary" size="sm" onClick={addSet}>
            <Plus className="h-4 w-4" /> Conjunto de dados
          </Button>
          <span className="text-xs text-muted">
            Valores em branco usam o gravado. Dados sigilosos nunca aparecem no documento nem no
            script.
          </span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!dirty}
            loading={busy === 'save'}
            onClick={() =>
              void run(
                'save',
                () =>
                  api.put(`/api/tests/sessions/${session.id}/data`, {
                    parameters,
                    dataSets: dataSets.map((d, i) => cleanValues(d, i, parameters, def.dataSets)),
                  }),
                'Dados salvos',
              )
            }
          >
            <Save className="h-4 w-4" /> Salvar dados
          </Button>
        </div>
      )}
    </Card>
  );
}

function RunResults({ session, run }: { session: TestSessionDto; run: TestRunDto }) {
  const def = session.definition;
  const steps = new Map(def.steps.map((s, i) => [s.id, { step: s, n: i + 1 }]));
  return (
    <ol className="flex flex-col gap-1.5">
      {run.results
        .filter((r) => !isStructuralStep(steps.get(r.stepId)?.step ?? { kind: 'goto' }))
        .map((r) => {
          const info = steps.get(r.stepId);
          return (
            <li key={r.stepId} className="flex flex-wrap items-start gap-2 text-sm">
              <span
                aria-label={r.status}
                className={
                  r.status === 'passed'
                    ? 'text-success'
                    : r.status === 'failed'
                      ? 'text-danger'
                      : 'text-subtle'
                }
              >
                {r.status === 'passed' ? '✔' : r.status === 'failed' ? '✖' : '–'}
              </span>
              <span className="min-w-0 flex-1">
                {info ? `${info.n}. ${stepTitle(def, info.step)}` : 'Passo removido'}
                {r.error && <span className="block text-xs text-danger">{r.error}</span>}
              </span>
              {r.screenshotUrl && (
                <a href={r.screenshotUrl} target="_blank" rel="noreferrer">
                  <img
                    src={r.screenshotUrl}
                    alt={`Tela na falha do passo ${info?.n ?? ''}`}
                    className="h-20 rounded-lg border border-border"
                  />
                </a>
              )}
            </li>
          );
        })}
    </ol>
  );
}

/** The data a run used, as saved with it (secret values masked). */
function RunData({ run }: { run: TestRunDto }) {
  if (!run.data) {
    return (
      <p className="text-xs text-subtle">
        Esta execução não guardou os dados que usou (ela é anterior a esse recurso).
      </p>
    );
  }
  return (
    <div className="text-xs">
      <p className="mb-1 font-medium text-muted">
        Dados usados · conjunto “{run.data.dataSetName}”
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {run.data.entries.map((e) => (
          <div key={e.paramId} className="contents">
            <dt className="text-subtle">{e.label}</dt>
            <dd className="break-all">{e.secret ? '••••••' : e.value || '(vazio)'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** "Reproduzir esta execução": runs again with exactly the data this run used. */
function RerunPanel({ session, run }: { session: TestSessionDto; run: TestRunDto }) {
  const rerun = run.rerun!;
  const [open, setOpen] = useState(false);
  const [headed, setHeaded] = useState(false);
  const { busy, run: act } = useSessionAction(session.id);
  const panelId = useId();
  const idle = session.state === 'idle';
  return (
    <div className="mt-2 w-full">
      <Button
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <RotateCcw className="h-4 w-4" /> Reproduzir esta execução
      </Button>
      {open && (
        <div
          id={panelId}
          className="mt-2 flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3"
        >
          {rerun.notice && (
            <p
              role="status"
              className={cn('text-sm', rerun.possible ? 'text-warning' : 'text-danger')}
            >
              {rerun.notice}
            </p>
          )}
          {rerun.warnings.length > 0 && (
            <ul role="status" className="list-disc pl-5 text-sm text-warning">
              {rerun.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {rerun.possible && (
            <>
              <p className="text-xs text-muted">
                {rerun.source === 'snapshot'
                  ? `Executa de novo com os mesmos dados da execução #${run.seq}, mesmo que o conjunto tenha mudado depois.`
                  : 'Executa de novo com os valores atuais do conjunto.'}
              </p>
              <RunData run={run} />
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm">
                  <Switch
                    checked={headed}
                    onChange={setHeaded}
                    label={`Ver a reprodução da execução ${run.seq} no navegador`}
                  />
                  Ver no navegador
                </label>
                <Button
                  size="sm"
                  disabled={!idle}
                  loading={busy === 'rerun'}
                  onClick={() =>
                    void act(
                      'rerun',
                      () =>
                        api.post(`/api/tests/sessions/${session.id}/runs`, {
                          rerunOf: run.id,
                          headed,
                        }),
                      'Reprodução iniciada',
                    ).then((ok) => ok && setOpen(false))
                  }
                >
                  <Play className="h-4 w-4" /> Executar reprodução
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RunRow({
  session,
  run,
  latest,
  downloads,
}: {
  session: TestSessionDto;
  run: TestRunDto;
  /** The most recent run: the only one that starts expanded (plus the one in progress). */
  latest: boolean;
  downloads: TestDownloadDto[];
}) {
  const active = run.status === 'queued' || run.status === 'running';
  const { hash } = useLocation();
  // a choice by the person wins; otherwise: the latest run, one in progress, or one linked to
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (latest || active || hash === `#run-${run.id}`);
  const bodyId = useId();
  const { busy, run: act } = useSessionAction(session.id);
  const executed = run.results.filter((r) => r.status !== 'skipped').length;
  const total = session.definition.steps.filter((s) => !isStructuralStep(s)).length;
  const hasBody = run.results.length > 0 || Boolean(run.data) || downloads.length > 0;
  return (
    <Card id={`run-${run.id}`} className="scroll-mt-4 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={open ? 'Recolher resultado' : 'Ver resultado'}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setToggled(!open)}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
        <span className="text-xs font-semibold text-muted">#{run.seq}</span>
        <RunStatusBadge status={run.status} />
        <span className="text-sm font-medium">{run.dataSetName ?? 'Conjunto removido'}</span>
        <span className="text-xs text-subtle">
          {formatTime(run.createdAt)}
          {active && ` · passo ${Math.min(executed + 1, total)} de ${total}`}
        </span>
        {run.rerunOf && (
          <span className="text-xs text-accent-text">
            reprodução da execução {run.rerunOfSeq ? `#${run.rerunOfSeq}` : 'anterior'}
          </span>
        )}
        {downloads.length > 0 && (
          <Badge>
            {downloads.length} {downloads.length === 1 ? 'arquivo' : 'arquivos'}
          </Badge>
        )}
        {active && (
          <Button
            variant="danger"
            size="sm"
            className="ml-auto"
            loading={busy === 'cancel'}
            onClick={() =>
              void act('cancel', () =>
                api.post(`/api/tests/sessions/${session.id}/runs/${run.id}/cancel`),
              )
            }
          >
            <Square className="h-4 w-4" /> Cancelar
          </Button>
        )}
      </div>
      {run.error && <p className="mt-2 text-sm text-danger">{run.error}</p>}
      {run.rerun && <RerunPanel session={session} run={run} />}
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            {hasBody && (
              <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                {!active && <RunData run={run} />}
                {downloads.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted">Arquivos baixados</p>
                    <ul className="flex flex-col gap-1 text-sm">
                      {downloads.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 break-all">{d.fileName}</span>
                          <span className="text-xs text-subtle">
                            {d.size > 0 ? formatFileSize(d.size) : ''}
                            {d.status !== 'saved' && ` · ${d.reason ?? ''}`}
                          </span>
                          <DownloadLink item={d} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {run.results.length > 0 && <RunResults session={session} run={run} />}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export function DataTab({ session }: { session: TestSessionDto }) {
  const def = session.definition;
  const { busy, run } = useSessionAction(session.id);
  const [dataSetId, setDataSetId] = useState<string>('');
  const [headed, setHeaded] = useState(false);
  const runnable = def.steps.some((s) => !isStructuralStep(s));
  const options = useMemo(() => def.dataSets, [def.dataSets]);
  const { data: downloads } = useTestDownloads(session.id, session.state !== 'idle');
  useScrollToHash();

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold">Dados do teste</h2>
        <DataTable key={session.id} session={session} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Executar novamente</h2>
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <Select
            aria-label="Conjunto de dados a executar"
            className="h-9 w-auto"
            value={dataSetId}
            onChange={(e) => setDataSetId(e.target.value)}
          >
            <option value="">Todos os conjuntos</option>
            {options.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <label className="inline-flex items-center gap-2 text-sm">
            <Switch checked={headed} onChange={setHeaded} label="Ver a execução no navegador" />
            Ver no navegador
          </label>
          <Button
            className="ml-auto"
            disabled={!runnable || session.state !== 'idle'}
            loading={busy === 'run'}
            onClick={() =>
              void run(
                'run',
                () =>
                  api.post(`/api/tests/sessions/${session.id}/runs`, {
                    dataSetId: dataSetId || null,
                    headed,
                  }),
                'Execução iniciada',
              )
            }
          >
            <Play className="h-4 w-4" /> Executar
          </Button>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Execuções</h2>
        {session.runs.length === 0 ? (
          <p className="text-sm text-muted">Nenhuma execução ainda.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {session.runs.map((r, i) => (
              <li key={r.id}>
                <RunRow
                  session={session}
                  run={r}
                  latest={i === 0}
                  downloads={(downloads ?? []).filter((d) => d.runId === r.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
