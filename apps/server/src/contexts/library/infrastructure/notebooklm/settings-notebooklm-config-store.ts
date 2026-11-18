import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTEBOOKLM_DEFAULTS } from '../../domain/notebooklm';
import type { NotebookLmPlan } from '@thinkflow/shared';
import type {
  NotebookLmConfig,
  NotebookLmConfigStore,
  NotebookLmDetectedLimits,
  NotebookLmLastCheck,
} from '../../domain/ports';
import type { SecretBox } from '../../../../shared/infrastructure/crypto';
import type { SettingsStore } from '../../../../shared/infrastructure/settings-store';

interface StoredConfig {
  enabled?: boolean;
  /** AES-256-GCM (SecretBox) of the storage_state.json content; '' = none. */
  authEnc?: string;
  cliCommand?: string;
  plan?: NotebookLmPlan;
  /** Only set when the user typed their own limit. */
  dailyQueryLimit?: number | null;
  detected?: NotebookLmDetectedLimits | null;
  detectionAttemptedAt?: number | null;
  detectionError?: string | null;
  timeoutSec?: number;
  fallbackToLocal?: boolean;
  credentialsUpdatedAt?: number | null;
  lastCheck?: NotebookLmLastCheck | null;
}

const KEY = 'notebooklm';
const QUERIES_KEY = 'notebooklmQueries';

/** Prefers the venv created for Thinkflow, else `notebooklm` from PATH. */
export function defaultNotebookLmCommand(homeDir: string = os.homedir()): string {
  const venv = path.join(homeDir, '.local', 'share', 'thinkflow', 'notebooklm-venv');
  // POSIX venvs use bin/, Windows venvs use Scripts/ (with an .exe launcher)
  const candidates = [
    path.join(venv, 'bin', 'notebooklm'),
    path.join(venv, 'Scripts', 'notebooklm.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? 'notebooklm';
}

/**
 * Keeps the NotebookLM settings in the `settings` table. The Google session (a Playwright
 * storage_state.json) is a secret: it is encrypted with the same AES-256-GCM `SecretBox` as provider
 * API keys and never stored in plaintext.
 */
export class SettingsNotebookLmConfigStore implements NotebookLmConfigStore {
  constructor(
    private readonly settings: SettingsStore,
    private readonly secrets: SecretBox,
    private readonly defaultCliCommand: () => string = () => defaultNotebookLmCommand(),
  ) {}

  get(): NotebookLmConfig {
    const stored = this.settings.get<StoredConfig>(KEY, {});
    let authJson: string | null = null;
    if (stored.authEnc) {
      try {
        authJson = this.secrets.decrypt(stored.authEnc) || null;
      } catch {
        authJson = null; // THINKFLOW_SECRET changed: the credentials must be provided again
      }
    }
    return {
      enabled: stored.enabled ?? false,
      authJson,
      cliCommand: stored.cliCommand?.trim() || this.defaultCliCommand(),
      plan: stored.plan ?? 'auto',
      dailyQueryLimit: stored.dailyQueryLimit ?? null,
      detected: stored.detected ?? null,
      detectionAttemptedAt: stored.detectionAttemptedAt ?? null,
      detectionError: stored.detectionError ?? null,
      timeoutSec: stored.timeoutSec ?? NOTEBOOKLM_DEFAULTS.timeoutSec,
      fallbackToLocal: stored.fallbackToLocal ?? NOTEBOOKLM_DEFAULTS.fallbackToLocal,
      credentialsUpdatedAt: authJson ? (stored.credentialsUpdatedAt ?? null) : null,
      lastCheck: stored.lastCheck ?? null,
    };
  }

  set(patch: Partial<NotebookLmConfig>): void {
    const stored = this.settings.get<StoredConfig>(KEY, {});
    const { authJson, ...rest } = patch;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const next: StoredConfig = { ...stored, ...defined };
    if (authJson !== undefined) next.authEnc = authJson ? this.secrets.encrypt(authJson) : '';
    this.settings.set(KEY, next);
  }

  countQuery(day: string): number {
    const count = this.queriesOn(day) + 1;
    this.settings.set(QUERIES_KEY, { day, count });
    return count;
  }

  queriesOn(day: string): number {
    const stored = this.settings.get<{ day?: string; count?: number }>(QUERIES_KEY, {});
    return stored.day === day ? (stored.count ?? 0) : 0;
  }
}
