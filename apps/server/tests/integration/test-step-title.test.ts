import { stepTitle, type TestSessionDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buttonFacts, FakeRecorderBrowser, instantSettler } from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';

describe('custom step title', () => {
  it('sets, clears and refuses the title while recording', async () => {
    const recorder = new FakeRecorderBrowser();
    t = await createTestApp({ tests: { recorder, settler: instantSettler } });
    const { json: created } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'Login',
      startUrl: 'https://a.b/login',
    });
    const id = created.id;
    await t.api('POST', `${BASE}/${id}/record/start`);
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    await t.container.tests.recording.whenIdle();
    const click = (await t.api<TestSessionDto>('GET', `${BASE}/${id}`)).json.definition.steps[1]!;
    const url = `${BASE}/${id}/steps/${click.id}`;

    // refused while recording
    expect((await t.api('PATCH', url, { title: 'Meu título' })).status).toBe(409);
    await t.api('POST', `${BASE}/${id}/record/stop`);

    const set = await t.api<TestSessionDto>('PATCH', url, { title: '  Entrar no sistema  ' });
    expect(set.status).toBe(200);
    const step = set.json.definition.steps[1]!;
    expect(step.title).toBe('Entrar no sistema');
    expect(stepTitle(set.json.definition, step)).toBe('Entrar no sistema');

    const cleared = await t.api<TestSessionDto>('PATCH', url, { title: '   ' });
    const back = cleared.json.definition.steps[1]!;
    expect(back.title).toBeNull();
    expect(stepTitle(cleared.json.definition, back)).toContain('Entrar');

    expect((await t.api('PATCH', url, { title: 'x'.repeat(301) })).status).toBe(400);
  });
});
