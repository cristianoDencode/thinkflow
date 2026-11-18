/** Pure helpers of the (experimental) NotebookLM integration. */
import {
  NOTEBOOKLM_PLANS,
  notebookLmPlanForTier,
  type NotebookLmPlan,
  type NotebookLmPlanKey,
} from '@thinkflow/shared';
import type { NotebookLmDetectedLimits } from './ports';

/** Stored Google cookies older than this are renewed (`auth refresh`) before the next call. */
export const AUTH_RENEW_AFTER_MS = 12 * 60 * 60 * 1000;

/** The account limits are re-read at most this often (unless the user asks: login, "Testar"). */
export const DETECTION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const NOTEBOOKLM_DEFAULTS = {
  timeoutSec: 120,
  fallbackToLocal: true,
} as const;

export const STORAGE_STATE_HELP =
  "Cole o conteúdo do arquivo storage_state.json gerado por 'notebooklm login'";

/**
 * Validates the content of a Playwright `storage_state.json` (a JSON object with a non-empty
 * `cookies` array). Returns the compacted JSON, or null when it does not look like one.
 * The content is a secret: callers must never log it.
 */
export function normalizeStorageState(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  return JSON.stringify(parsed);
}

/** 'YYYY-MM-DD' (UTC) used for the daily query counter. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function credentialsNeedRenewal(updatedAt: number | null, now: number): boolean {
  return updatedAt !== null && now - updatedAt > AUTH_RENEW_AFTER_MS;
}

export interface EffectiveNotebookLmLimits {
  sourceLimit: number;
  notebookLimit: number;
  chatsPerDay: number;
  /** Where the source limit came from. */
  origin: 'detected' | 'plan' | 'default';
  /** The plan the limits correspond to (chosen or recognised from the detected tier), if any. */
  plan: NotebookLmPlanKey | null;
}

/**
 * Limits the app enforces. Source/notebook limit: what the account reported → the chosen plan's
 * table value → the plan of the detected tier → Free. Chats per day: a custom value wins, else the
 * same plan table.
 */
export function effectiveNotebookLmLimits(config: {
  plan: NotebookLmPlan;
  dailyQueryLimit: number | null;
  detected: NotebookLmDetectedLimits | null;
}): EffectiveNotebookLmLimits {
  const chosen: NotebookLmPlanKey | null = config.plan === 'auto' ? null : config.plan;
  const detectedPlan = notebookLmPlanForTier(config.detected?.tier);
  const plan = chosen ?? detectedPlan;
  const table = NOTEBOOKLM_PLANS[chosen ?? detectedPlan ?? 'free'];
  const liveSources = config.detected?.sourceLimit;
  const sourceLimit = liveSources && liveSources > 0 ? liveSources : null;
  return {
    sourceLimit: sourceLimit ?? table.sourcesPerNotebook,
    notebookLimit: config.detected?.notebookLimit ?? table.notebooks,
    chatsPerDay: config.dailyQueryLimit ?? table.chatsPerDay,
    origin: sourceLimit ? 'detected' : plan ? 'plan' : 'default',
    plan,
  };
}

/**
 * Recognises an error saying the notebook cannot take more sources and returns the limit it
 * mentions (null when it names none). Returns undefined when the text is about something else.
 */
export function parseSourceLimitError(text: string): { limit: number | null } | undefined {
  if (!/\bsources?\b/i.test(text)) return undefined;
  if (!/limit|maximum|max\.|too many|exceed|reached|cap\b|full\b/i.test(text)) return undefined;
  if (/rate.?limit|too many requests|\b429\b|daily|per day/i.test(text)) return undefined;
  const near =
    /(?:limit|maximum|max|up to|at most|exceed(?:s|ed)?)\D{0,30}?(\d{2,4})\b/i.exec(text) ??
    /\b(\d{2,4})\s+sources?\b/i.exec(text);
  const limit = near ? Number(near[1]) : null;
  return { limit: limit !== null && limit >= 10 && limit <= 5000 ? limit : null };
}

export function sourceLimitMessage(limit: number | null): string {
  return limit
    ? `A conta do NotebookLM permite no máximo ${limit} fontes por notebook`
    : 'O notebook atingiu o limite de fontes da conta do NotebookLM';
}
