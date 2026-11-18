import {
  LIBRARY_LIMITS,
  NOTEBOOKLM_PLANS,
  maxDocumentsFor,
  notebookLmPlanForTier,
} from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { NotebookLmSettingsService } from '../../src/contexts/library/application/notebooklm-settings-service';
import {
  DETECTION_MAX_AGE_MS,
  effectiveNotebookLmLimits,
  parseSourceLimitError,
  sourceLimitMessage,
} from '../../src/contexts/library/domain/notebooklm';
import type { NotebookLmLocalProfile } from '../../src/contexts/library/domain/ports';
import {
  FakeNotebookLmGateway,
  FakeNotebookLmProbe,
  MemoryNotebookLmConfig,
  fakeStorageState,
  proAccount,
} from './notebooklm-helpers';

describe('maxDocumentsFor', () => {
  it('gives local libraries 1000 documents whatever the account says', () => {
    expect(maxDocumentsFor('local')).toBe(1000);
    expect(maxDocumentsFor('local', 50)).toBe(1000);
    expect(LIBRARY_LIMITS.maxLibraryChars).toBe(60_000_000);
  });

  it('follows the account source limit for NotebookLM, Free (50) when unknown', () => {
    expect(maxDocumentsFor('notebooklm', 300)).toBe(300);
    expect(maxDocumentsFor('notebooklm')).toBe(50);
    expect(maxDocumentsFor('notebooklm', null)).toBe(50);
    expect(maxDocumentsFor('notebooklm', 0)).toBe(50);
  });
});

describe('plan table', () => {
  it('matches the published values', () => {
    const row = (k: keyof typeof NOTEBOOKLM_PLANS) =>
      [
        NOTEBOOKLM_PLANS[k].notebooks,
        NOTEBOOKLM_PLANS[k].sourcesPerNotebook,
        NOTEBOOKLM_PLANS[k].chatsPerDay,
      ] as const;
    expect(row('free')).toEqual([100, 50, 50]);
    expect(row('plus')).toEqual([200, 100, 200]);
    expect(row('pro')).toEqual([500, 300, 500]);
    expect(row('ultra20')).toEqual([500, 500, 2500]);
    expect(row('ultra30')).toEqual([500, 600, 5000]);
    expect(row('workspace')).toEqual([500, 400, 1000]);
  });

  it('maps the opaque tier keys, not ordinals', () => {
    expect(notebookLmPlanForTier(1)).toBe('free');
    expect(notebookLmPlanForTier(2)).toBe('pro');
    expect(notebookLmPlanForTier(3)).toBe('ultra20');
    expect(notebookLmPlanForTier(4)).toBe('plus');
    expect(notebookLmPlanForTier(5)).toBe('workspace');
    expect(notebookLmPlanForTier(6)).toBe('ultra30');
    expect(notebookLmPlanForTier(99)).toBeNull();
    expect(notebookLmPlanForTier(null)).toBeNull();
  });
});

describe('effectiveNotebookLmLimits', () => {
  const base = { plan: 'auto', dailyQueryLimit: null, detected: null } as const;

  it('is Free when nothing is known', () => {
    expect(effectiveNotebookLmLimits(base)).toEqual({
      sourceLimit: 50,
      notebookLimit: 100,
      chatsPerDay: 50,
      origin: 'default',
      plan: null,
    });
  });

  it('uses the chosen plan when nothing was detected', () => {
    expect(effectiveNotebookLmLimits({ ...base, plan: 'ultra30' })).toMatchObject({
      sourceLimit: 600,
      chatsPerDay: 5000,
      origin: 'plan',
      plan: 'ultra30',
    });
  });

  it('prefers the live source limit over the chosen plan', () => {
    const detected = { at: 1, sourceLimit: 250, notebookLimit: 400, tier: 2 };
    expect(effectiveNotebookLmLimits({ ...base, plan: 'plus', detected })).toMatchObject({
      sourceLimit: 250,
      notebookLimit: 400,
      chatsPerDay: 200, // the chosen plan decides the chats
      origin: 'detected',
    });
  });

  it('derives chats per day from the detected tier in automatic mode', () => {
    const detected = { at: 1, sourceLimit: 300, notebookLimit: 500, tier: 2 };
    expect(effectiveNotebookLmLimits({ ...base, detected })).toMatchObject({
      sourceLimit: 300,
      chatsPerDay: 500,
      plan: 'pro',
    });
  });

  it('keeps an unknown tier harmless', () => {
    const detected = { at: 1, sourceLimit: 123, notebookLimit: null, tier: 42 };
    expect(effectiveNotebookLmLimits({ ...base, detected })).toMatchObject({
      sourceLimit: 123,
      chatsPerDay: 50,
      plan: null,
    });
  });

  it('lets a custom daily limit win over the plan', () => {
    expect(
      effectiveNotebookLmLimits({ ...base, plan: 'pro', dailyQueryLimit: 7 }).chatsPerDay,
    ).toBe(7);
  });
});

describe('parseSourceLimitError', () => {
  it.each([
    ['Notebook has reached the source limit (300 sources)', 300],
    ['Cannot add more sources: maximum of 50 sources per notebook', 50],
    ['You have exceeded the limit of 100 sources', 100],
    ['source limit reached', null],
  ])('recognises %j', (text, limit) => {
    expect(parseSourceLimitError(text)).toEqual({ limit });
  });

  it.each([
    'HTTP 429 Too Many Requests',
    'daily source import quota reached',
    'Session expired, please login',
    'source not found',
    'rate limit exceeded while adding a source',
  ])('ignores %j', (text) => {
    expect(parseSourceLimitError(text)).toBeUndefined();
  });

  it('words the pt-BR message', () => {
    expect(sourceLimitMessage(300)).toBe(
      'A conta do NotebookLM permite no máximo 300 fontes por notebook',
    );
    expect(sourceLimitMessage(null)).toMatch(/limite de fontes/);
  });
});

describe('NotebookLmSettingsService: limit detection', () => {
  const profile: NotebookLmLocalProfile = { read: async () => null, exists: () => false };
  let now = 1_000_000;

  function make(probe: FakeNotebookLmProbe | undefined, patch = {}) {
    const config = new MemoryNotebookLmConfig({ enabled: false, ...patch });
    const service = new NotebookLmSettingsService({
      config,
      gateway: new FakeNotebookLmGateway(),
      login: { support: () => ({ supported: false, message: '' }), start: () => ({}) as never },
      localProfile: profile,
      ...(probe ? { probe } : {}),
      clock: { now: () => now },
    });
    return { config, service };
  }

  it('detects on "Testar conexão" and reports the effective limits', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    const { service } = make(probe);
    expect(service.get()).toMatchObject({ plan: 'auto', sourceLimit: 50, dailyQueryLimit: 50 });
    await service.test();
    expect(probe.calls).toBe(1);
    expect(service.get()).toMatchObject({
      sourceLimit: 300,
      notebookLimit: 500,
      dailyQueryLimit: 500,
      dailyQueryLimitCustom: false,
      detection: { at: now, sourceLimit: 300, tier: 2, planLabel: 'Pro', unavailableReason: null },
    });
  });

  it('detects right after new credentials are saved, and clears everything on removal', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    const { service, config } = make(probe, { authJson: null });
    await service.update({ authJson: fakeStorageState() });
    expect(probe.calls).toBe(1);
    expect(config.get().detected?.sourceLimit).toBe(300);
    await service.removeCredentials();
    expect(config.get()).toMatchObject({
      detected: null,
      detectionError: null,
      detectionAttemptedAt: null,
    });
    expect(service.get().sourceLimit).toBe(50);
  });

  it('runs lazily at most once every 12 h, but always when forced', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    const { service } = make(probe);
    await service.detectLimits();
    await service.detectLimits();
    expect(probe.calls).toBe(1);
    now += DETECTION_MAX_AGE_MS - 1;
    await service.detectLimits();
    expect(probe.calls).toBe(1);
    now += 2;
    await service.detectLimits();
    expect(probe.calls).toBe(2);
    await service.detectLimits(true);
    expect(probe.calls).toBe(3);
  });

  it('does not run twice at once', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    const { service } = make(probe);
    await Promise.all([service.detectLimits(true), service.detectLimits(true)]);
    expect(probe.calls).toBe(1);
  });

  it('falls back to the chosen plan and explains why when detection is unavailable', async () => {
    const probe = new FakeNotebookLmProbe({
      ok: false,
      reason: 'Detecção automática indisponível: x.',
    });
    const { service } = make(probe);
    await service.update({ plan: 'plus' });
    await service.detectLimits(true);
    expect(service.get()).toMatchObject({
      plan: 'plus',
      sourceLimit: 100,
      dailyQueryLimit: 200,
      detection: { at: null, unavailableReason: 'Detecção automática indisponível: x.' },
    });
  });

  it('keeps previously detected values when a later detection fails', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    const { service } = make(probe);
    await service.detectLimits(true);
    probe.result = { ok: false, reason: 'agora não deu' };
    await service.detectLimits(true);
    expect(service.get()).toMatchObject({
      sourceLimit: 300,
      detection: { sourceLimit: 300, unavailableReason: 'agora não deu' },
    });
  });

  it('survives a probe that throws, and works without a probe', async () => {
    const errors: unknown[] = [];
    const probe = new FakeNotebookLmProbe(new Error('boom'));
    const config = new MemoryNotebookLmConfig();
    const service = new NotebookLmSettingsService({
      config,
      gateway: new FakeNotebookLmGateway(),
      login: { support: () => ({ supported: false, message: '' }), start: () => ({}) as never },
      localProfile: profile,
      probe,
      clock: { now: () => now },
      onError: (e) => errors.push(e),
    });
    await service.detectLimits(true);
    expect(errors).toHaveLength(1);
    expect(service.get().detection.unavailableReason).toMatch(/Falha/);

    const bare = make(undefined);
    await bare.service.detectLimits(true);
    expect(bare.service.get().detection.unavailableReason).toMatch(/indisponível/);
    expect(bare.service.get().sourceLimit).toBe(50);
  });

  it('does nothing without credentials', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    const { service } = make(probe, { authJson: null });
    await service.detectLimits(true);
    expect(probe.calls).toBe(0);
  });

  it('keeps a custom daily limit until the user goes back to the plan', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    const { service } = make(probe);
    await service.update({ dailyQueryLimit: 12 });
    await service.detectLimits(true);
    expect(service.get()).toMatchObject({ dailyQueryLimit: 12, dailyQueryLimitCustom: true });
    await service.update({ dailyQueryLimit: null });
    expect(service.get()).toMatchObject({ dailyQueryLimit: 500, dailyQueryLimitCustom: false });
  });

  it('validates the plan', async () => {
    const { service } = make(undefined);
    await expect(service.update({ plan: 'gigante' })).rejects.toBeTruthy();
  });
});
