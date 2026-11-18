import { describe, expect, it } from 'vitest';
import {
  credentialsNeedRenewal,
  dayKey,
  normalizeStorageState,
} from '../../src/contexts/library/domain/notebooklm';
import { SettingsNotebookLmConfigStore } from '../../src/contexts/library/infrastructure/notebooklm/settings-notebooklm-config-store';
import { SecretBox } from '../../src/shared/infrastructure/crypto';
import { openDatabase } from '../../src/shared/infrastructure/db/client';
import { SettingsStore } from '../../src/shared/infrastructure/settings-store';
import { fakeStorageState } from './notebooklm-helpers';

function makeStore(secret = 's1') {
  const handle = openDatabase(':memory:');
  const settings = new SettingsStore(handle.db);
  const store = new SettingsNotebookLmConfigStore(
    settings,
    new SecretBox(secret),
    () => 'notebooklm',
  );
  return { handle, settings, store };
}

describe('SettingsNotebookLmConfigStore', () => {
  it('has safe defaults', () => {
    const { store, handle } = makeStore();
    expect(store.get()).toEqual({
      enabled: false,
      authJson: null,
      cliCommand: 'notebooklm',
      plan: 'auto',
      dailyQueryLimit: null,
      detected: null,
      detectionAttemptedAt: null,
      detectionError: null,
      timeoutSec: 120,
      fallbackToLocal: true,
      credentialsUpdatedAt: null,
      lastCheck: null,
    });
    handle.close();
  });

  it('encrypts the credentials at rest and ignores undefined patch values', () => {
    const { store, settings, handle } = makeStore();
    const auth = fakeStorageState('plain-cookie');
    store.set({ authJson: auth, credentialsUpdatedAt: 5, dailyQueryLimit: 7 });
    store.set({ dailyQueryLimit: undefined, timeoutSec: 33 });
    const raw = JSON.stringify(settings.get('notebooklm', {}));
    expect(raw).not.toContain('plain-cookie');
    expect(store.get()).toMatchObject({
      authJson: auth,
      credentialsUpdatedAt: 5,
      dailyQueryLimit: 7,
      timeoutSec: 33,
    });
    store.set({ authJson: null });
    expect(store.get().authJson).toBeNull();
    expect(store.get().credentialsUpdatedAt).toBeNull();
    handle.close();
  });

  it('stores the plan, the detected account limits and a custom daily limit', () => {
    const { store, handle } = makeStore();
    store.set({
      plan: 'pro',
      dailyQueryLimit: 120,
      detected: { at: 9, sourceLimit: 300, notebookLimit: 500, tier: 2 },
      detectionAttemptedAt: 9,
      detectionError: null,
    });
    expect(store.get()).toMatchObject({
      plan: 'pro',
      dailyQueryLimit: 120,
      detected: { at: 9, sourceLimit: 300, notebookLimit: 500, tier: 2 },
      detectionAttemptedAt: 9,
    });
    store.set({ dailyQueryLimit: null, detected: null });
    expect(store.get()).toMatchObject({ dailyQueryLimit: null, detected: null, plan: 'pro' });
    handle.close();
  });

  it('treats credentials as missing when the secret changed', () => {
    const { store, settings, handle } = makeStore('old-secret');
    store.set({ authJson: fakeStorageState(), credentialsUpdatedAt: 1 });
    const other = new SettingsNotebookLmConfigStore(
      settings,
      new SecretBox('new-secret'),
      () => 'x',
    );
    expect(other.get().authJson).toBeNull();
    handle.close();
  });

  it('counts queries per day', () => {
    const { store, handle } = makeStore();
    expect(store.queriesOn('2026-11-11')).toBe(0);
    expect(store.countQuery('2026-11-11')).toBe(1);
    expect(store.countQuery('2026-11-11')).toBe(2);
    expect(store.queriesOn('2026-11-11')).toBe(2);
    expect(store.queriesOn('2026-11-12')).toBe(0);
    expect(store.countQuery('2026-11-12')).toBe(1);
    handle.close();
  });
});

describe('notebooklm domain helpers', () => {
  it('validates storage_state content', () => {
    expect(normalizeStorageState(` ${fakeStorageState()} `)).toBe(fakeStorageState());
    for (const bad of ['', 'x', '[]', '{}', '{"cookies":[]}', '{"cookies":"a"}', 'null'])
      expect(normalizeStorageState(bad)).toBeNull();
  });
  it('formats the UTC day and decides renewal at 12 h', () => {
    expect(dayKey(Date.UTC(2026, 10, 11, 23, 59))).toBe('2026-11-11');
    const now = 1_000_000_000_000;
    expect(credentialsNeedRenewal(now - 11 * 3_600_000, now)).toBe(false);
    expect(credentialsNeedRenewal(now - 12.5 * 3_600_000, now)).toBe(true);
    expect(credentialsNeedRenewal(null, now)).toBe(false);
  });
});
