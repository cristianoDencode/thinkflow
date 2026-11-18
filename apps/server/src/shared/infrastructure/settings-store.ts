import { eq } from 'drizzle-orm';
import {
  modelAliasesSchema,
  privacySettingsSchema,
  type ModelAliases,
  type PrivacySettings,
} from '@thinkflow/shared';
import type { Db } from './db/client';
import { settings } from './db/schema';

/** Tiny key/value store for global settings (JSON values). */
export class SettingsStore {
  constructor(private readonly db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    this.db
      .insert(settings)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: settings.key, set: { value: json } })
      .run();
  }

  /** Privacy firewall settings (`privacy.enabled`, `privacy.presidioUrl`, `privacy.minScore`). */
  privacy(): PrivacySettings {
    const parsed = privacySettingsSchema.safeParse({
      enabled: this.get<unknown>('privacy.enabled', undefined),
      presidioUrl: this.get<unknown>('privacy.presidioUrl', undefined),
      minScore: this.get<unknown>('privacy.minScore', undefined),
    });
    // a corrupt value must never switch the firewall off: fall back to the safe defaults
    return parsed.success ? parsed.data : privacySettingsSchema.parse({});
  }

  setPrivacy(update: Partial<PrivacySettings>): void {
    if (update.enabled !== undefined) this.set('privacy.enabled', update.enabled);
    if (update.presidioUrl !== undefined) this.set('privacy.presidioUrl', update.presidioUrl);
    if (update.minScore !== undefined) this.set('privacy.minScore', update.minScore);
  }

  async getAliases(): Promise<ModelAliases> {
    return modelAliasesSchema.parse(this.get('aliases', {}));
  }
}
