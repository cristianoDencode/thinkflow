import type { TestRunDto, TestSessionDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testRuns } from '../../src/shared/infrastructure/db/schema';
import { INTERRUPTED_MESSAGE } from '../../src/contexts/testing/application/run-service';
import {
  buttonFacts,
  fieldFacts,
  FakeRecorderBrowser,
  FakeRunner,
  instantSettler,
} from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';
const get = (id: string) => t!.api<TestSessionDto>('GET', `${BASE}/${id}`).then((r) => r.json);

/** A recorded session: goto, fill E-mail, fill Senha (secret), click Entrar. */
async function recorded(runner = new FakeRunner(), display = true) {
  const recorder = new FakeRecorderBrowser();
  t = await createTestApp({
    tests: { recorder, runner, settler: instantSettler, display: { canOpenWindow: () => display } },
  });
  const { json } = await t.api<TestSessionDto>('POST', BASE, {
    name: 'Login',
    startUrl: 'https://a.b/login',
  });
  if (display) {
    await t.api('POST', `${BASE}/${json.id}/record/start`);
    recorder.emit({ type: 'fill', facts: fieldFacts('E-mail'), value: 'ana@x.com', at: 1 });
    recorder.emit({
      type: 'fill',
      facts: fieldFacts('Senha', { secret: true, role: null }),
      value: 'segredo',
      at: 2,
    });
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 3 });
    await t.container.tests.recording.whenIdle();
    await t.api('POST', `${BASE}/${json.id}/record/stop`);
  }
  return { runner, id: json.id, session: await get(json.id) };
}

describe('data sets', () => {
  it('edits parameters and data sets, never exposing secrets', async () => {
    const { id, session } = await recorded();
    const [email, senha] = session.definition.parameters;
    expect(senha).toMatchObject({ type: 'password', secret: true });
    const res = await t!.api<TestSessionDto>('PUT', `${BASE}/${id}/data`, {
      parameters: [{ ...email!, label: 'E-mail do titular' }, senha],
      dataSets: [
        session.definition.dataSets[0],
        {
          id: 'invalido',
          name: 'E-mail inválido',
          values: { [email!.id]: 'ana@', [senha!.id]: 'nova-senha' },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.definition.parameters[0]!.label).toBe('E-mail do titular');
    expect(res.json.definition.dataSets[1]!.values).toEqual({
      [email!.id]: 'ana@',
      [senha!.id]: { $secret: true },
    });
    expect(JSON.stringify(res.json)).not.toMatch(/segredo|nova-senha/);
  });
});

describe('replays', () => {
  it('runs every data set with its values and saves results step by step', async () => {
    const { runner, id, session } = await recorded();
    const [email, senha] = session.definition.parameters;
    await t!.api('PUT', `${BASE}/${id}/data`, {
      parameters: session.definition.parameters,
      dataSets: [
        session.definition.dataSets[0],
        { id: 'invalido', name: 'E-mail inválido', values: { [email!.id]: 'ana@' } },
      ],
    });
    const res = await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, { dataSetId: null });
    expect(res.status).toBe(202);
    expect(res.json.map((r) => [r.dataSetName, r.status])).toEqual([
      ['Gravado', 'queued'],
      ['E-mail inválido', 'queued'],
    ]);
    await t!.container.tests.runs.whenIdle();

    // secrets reach the runner (and only the runner); missing values fall back to the recording
    expect(runner.inputs.map((i) => i.values)).toEqual([
      { [email!.id]: 'ana@x.com', [senha!.id]: 'segredo' },
      { [email!.id]: 'ana@', [senha!.id]: 'segredo' },
    ]);
    expect(runner.inputs[0]!.maskCss).toContain('input[type=password]');

    const s = await get(id);
    expect(s.state).toBe('idle');
    expect(s.runs.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(s.runs[0]!.results.map((r) => r.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
    expect(s.lastRun).toMatchObject({ status: 'passed' });
  });

  it('records the failing step with its screenshot and skips the rest', async () => {
    const runner = new FakeRunner();
    const { id, session } = await recorded(runner);
    runner.failAt = session.definition.steps[2]!.id;
    const [run] = (
      await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, { dataSetId: 'recorded' })
    ).json;
    await t!.container.tests.runs.whenIdle();
    const done = (await t!.api<TestRunDto>('GET', `${BASE}/${id}/runs/${run!.id}`)).json;
    expect(done.status).toBe('failed');
    expect(done.results.map((r) => r.status)).toEqual(['passed', 'passed', 'failed', 'skipped']);
    const failure = done.results[2]!;
    expect(failure.error).toContain('Elemento não encontrado');
    expect(failure.screenshotUrl).toContain(`/runs/${run!.id}/`);
    const img = await t!.app.inject({
      method: 'GET',
      url: failure.screenshotUrl!,
      headers: { cookie: t!.cookie },
    });
    expect(img.statusCode).toBe(200);
  });

  it('passes a checkpoint without interacting and keeps its screenshot', async () => {
    const { id } = await recorded();
    await t!.api('POST', `${BASE}/${id}/record/start`);
    await t!.container.tests.recording.whenIdle();
    await t!.api('POST', `${BASE}/${id}/record/checkpoint`);
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    const steps = (await get(id)).definition.steps;
    const checkpoint = steps.find((s) => s.kind === 'checkpoint')!;
    const [run] = (await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, { dataSetId: null }))
      .json;
    await t!.container.tests.runs.whenIdle();
    const done = (await t!.api<TestRunDto>('GET', `${BASE}/${id}/runs/${run!.id}`)).json;
    expect(done.status).toBe('passed');
    const result = done.results.find((r) => r.stepId === checkpoint.id)!;
    expect(result).toMatchObject({ status: 'passed', error: null, locatorUsed: null });
    expect(result.screenshotUrl).toContain(`/runs/${run!.id}/`);
    // the other steps keep no screenshot
    expect(done.results.filter((r) => r.screenshotUrl)).toHaveLength(1);
  });

  it('a session with only checkpoints has nothing to run', async () => {
    const { id } = await recorded();
    await t!.api('POST', `${BASE}/${id}/record/start`);
    await t!.container.tests.recording.whenIdle();
    await t!.api('POST', `${BASE}/${id}/record/checkpoint`);
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    for (const step of (await get(id)).definition.steps) {
      if (step.kind !== 'checkpoint') await t!.api('DELETE', `${BASE}/${id}/steps/${step.id}`);
    }
    const left = (await get(id)).definition;
    expect(left.steps.map((s) => s.kind)).toEqual(['checkpoint']);
    const res = await t!.api<{ error: { code: string } }>('POST', `${BASE}/${id}/runs`, {});
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('no_steps');
  });

  it('cancels a running replay and marks it busy meanwhile', async () => {
    const runner = new FakeRunner();
    let release!: () => void;
    runner.gate = new Promise<void>((r) => (release = r));
    const { id } = await recorded(runner);
    const [run] = (await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, {})).json;
    await vi.waitFor(async () => expect((await get(id)).state).toBe('running'));
    // nothing else may touch the session while it runs
    expect((await t!.api('POST', `${BASE}/${id}/record/start`)).status).toBe(409);
    expect((await t!.api('POST', `${BASE}/${id}/runs`, {})).status).toBe(409);
    expect((await t!.api('PATCH', `${BASE}/${id}`, { name: 'x' })).status).toBe(409);

    const canceling = t!.api<TestRunDto>('POST', `${BASE}/${id}/runs/${run!.id}/cancel`);
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await canceling).json.status).toBe('canceled');
    expect((await get(id)).state).toBe('idle');
  });

  it('reports a browser that cannot start and refuses headed runs without a screen', async () => {
    const runner = new FakeRunner();
    runner.failToStart = 'Chromium não encontrado em X; rode playwright install chromium.';
    const { id } = await recorded(runner);
    const [run] = (await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, {})).json;
    await t!.container.tests.runs.whenIdle();
    const failed = (await t!.api<TestRunDto>('GET', `${BASE}/${id}/runs/${run!.id}`)).json;
    expect(failed).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Chromium não encontrado'),
    });

    await t!.close();
    const { id: other } = await recorded(new FakeRunner(), false);
    const headed = await t!.api<{ error: { code: string } }>('POST', `${BASE}/${other}/runs`, {
      headed: true,
    });
    expect(headed.status).toBe(400);
    const empty = await t!.api<{ error: { code: string } }>('POST', `${BASE}/${other}/runs`, {});
    expect(empty.json.error.code).toBe('no_steps');
  });

  it('marks runs left over by a previous process as interrupted', async () => {
    const { id } = await recorded();
    await t!.container.tests.repo.saveRun({
      id: 'old',
      sessionId: id,
      seq: 1,
      rerunOf: null,
      snapshot: null,
      dataSetId: 'recorded',
      status: 'running',
      headed: false,
      results: [],
      error: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: null,
    });
    await t!.container.tests.runs.recoverInterrupted();
    const run = (await t!.api<TestRunDto>('GET', `${BASE}/${id}/runs/old`)).json;
    expect(run).toMatchObject({ status: 'error', error: INTERRUPTED_MESSAGE });
  });
});

describe('the data of a run and its reproduction', () => {
  const putData = async (id: string, edit: (email: string, senha: string) => object) => {
    const session = await get(id);
    const [email, senha] = session.definition.parameters;
    return t!.api('PUT', `${BASE}/${id}/data`, {
      parameters: session.definition.parameters,
      dataSets: [{ ...session.definition.dataSets[0], ...edit(email!.id, senha!.id) }],
    });
  };
  const run = async (id: string, body: object = {}) => {
    const [r] = (await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, body)).json;
    await t!.container.tests.runs.whenIdle();
    return (await t!.api<TestRunDto>('GET', `${BASE}/${id}/runs/${r!.id}`)).json;
  };

  it('keeps the data a run used: secrets encrypted at rest and masked for the screen', async () => {
    const { id } = await recorded();
    const first = await run(id);
    expect(first).toMatchObject({ seq: 1, rerunOf: null, rerunOfSeq: null });
    expect(first.data).toEqual({
      dataSetName: 'Gravado',
      entries: [
        expect.objectContaining({ label: 'E-mail', secret: false, value: 'ana@x.com' }),
        expect.objectContaining({ label: 'Senha', secret: true, value: null }),
      ],
    });
    expect(JSON.stringify(first)).not.toContain('segredo');

    const [row] = t!.db.select().from(testRuns).all();
    expect(row!.dataSnapshot).toContain('ana@x.com');
    expect(row!.dataSnapshot).not.toContain('segredo');
    expect(row!.dataSecretsEnc).not.toBe('');
    expect(row!.dataSecretsEnc).not.toContain('segredo');
    // read back (decrypted) by the repository
    expect((await t!.container.tests.repo.findRun(first.id))!.snapshot!.secrets).toEqual({
      [first.data!.entries[1]!.paramId]: 'segredo',
    });

    const second = await run(id);
    expect(second.seq).toBe(2);
  });

  it('reproduces a run with the data it used, not the current values, as a new run', async () => {
    const runner = new FakeRunner();
    const { id } = await recorded(runner);
    const original = await run(id);
    await putData(id, (email) => ({ values: { [email]: 'trocado@x.com' } }));
    const withWarning = (await get(id)).runs.find((r) => r.id === original.id)!;
    expect(withWarning.rerun).toMatchObject({ source: 'snapshot', possible: true, notice: null });
    expect(withWarning.rerun!.warnings).toEqual([
      expect.stringContaining('Valores alterados desde esta execução: "E-mail"'),
    ]);

    const [again] = (
      await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, {
        rerunOf: original.id,
        dataSetId: 'ignorado',
        headed: false,
      })
    ).json;
    await t!.container.tests.runs.whenIdle();
    const [email, senha] = (await get(id)).definition.parameters;
    // the runner got the original values, secret included
    expect(runner.inputs.at(-1)!.values).toEqual({
      [email!.id]: 'ana@x.com',
      [senha!.id]: 'segredo',
    });
    const done = (await t!.api<TestRunDto>('GET', `${BASE}/${id}/runs/${again!.id}`)).json;
    expect(done).toMatchObject({ seq: 2, rerunOf: original.id, rerunOfSeq: 1, status: 'passed' });
    expect(done.data!.entries[0]!.value).toBe('ana@x.com');
    // history keeps both
    expect((await get(id)).runs.map((r) => r.seq)).toEqual([2, 1]);
  });

  it('still reproduces with a warning when parameters or the data set changed since', async () => {
    const runner = new FakeRunner();
    const { id, session } = await recorded(runner);
    const original = await run(id);
    // removing the step that fills the password drops that parameter
    const senhaStep = session.definition.steps.find(
      (s) =>
        s.kind === 'fill' &&
        s.value &&
        'param' in s.value &&
        s.value.param === session.definition.parameters[1]!.id,
    )!;
    await t!.api('DELETE', `${BASE}/${id}/steps/${senhaStep.id}`);
    const warnings = (await get(id)).runs[0]!.rerun!.warnings;
    expect(warnings).toEqual([
      expect.stringContaining('Dados que não existem mais nos passos: "Senha"'),
    ]);
    const again = await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, {
      rerunOf: original.id,
    });
    expect(again.status).toBe(202);
    await t!.container.tests.runs.whenIdle();
    expect(Object.values(runner.inputs.at(-1)!.values)).toContain('segredo');
    expect(original.id).not.toBe(again.json[0]!.id);
  });

  it('falls back to the current values for runs that kept no data, and says so', async () => {
    const runner = new FakeRunner();
    const { id } = await recorded(runner);
    const repo = t!.container.tests.repo;
    await repo.saveRun({
      id: 'antiga',
      sessionId: id,
      seq: 1,
      rerunOf: null,
      snapshot: null,
      dataSetId: 'recorded',
      status: 'failed',
      headed: false,
      results: [],
      error: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
    });
    const old = (await get(id)).runs.find((r) => r.id === 'antiga')!;
    expect(old.data).toBeNull();
    expect(old.rerun).toMatchObject({
      source: 'current',
      possible: true,
      notice: 'Valores atuais do conjunto "Gravado": a execução original não guardou os dados.',
    });
    await putData(id, (email) => ({ values: { [email]: 'hoje@x.com' } }));
    const res = await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, { rerunOf: 'antiga' });
    expect(res.status).toBe(202);
    await t!.container.tests.runs.whenIdle();
    expect(Object.values(runner.inputs.at(-1)!.values)).toContain('hoje@x.com');
    expect(res.json[0]).toMatchObject({ rerunOf: 'antiga', seq: 2, rerunOfSeq: 1 });

    // data set removed too: nothing to reproduce it with
    await repo.saveRun({
      id: 'sem-conjunto',
      sessionId: id,
      seq: 3,
      rerunOf: null,
      snapshot: null,
      dataSetId: 'removido',
      status: 'passed',
      headed: false,
      results: [],
      error: null,
      createdAt: 3,
      startedAt: 3,
      finishedAt: 4,
    });
    const gone = (await get(id)).runs.find((r) => r.id === 'sem-conjunto')!;
    expect(gone.rerun).toMatchObject({ possible: false });
    const refused = await t!.api<{ error: { code: string } }>('POST', `${BASE}/${id}/runs`, {
      rerunOf: 'sem-conjunto',
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('rerun_impossible');
  });

  it('only reproduces finished runs of the same session', async () => {
    const runner = new FakeRunner();
    let release!: () => void;
    runner.gate = new Promise<void>((r) => (release = r));
    const { id } = await recorded(runner);
    const [running] = (await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, {})).json;
    await vi.waitFor(async () => expect((await get(id)).state).toBe('running'));
    expect((await t!.api('POST', `${BASE}/${id}/runs`, { rerunOf: running!.id })).status).toBe(409);
    release();
    await t!.container.tests.runs.whenIdle();
    expect((await t!.api('POST', `${BASE}/${id}/runs`, { rerunOf: 'nao-existe' })).status).toBe(
      404,
    );
  });
});
