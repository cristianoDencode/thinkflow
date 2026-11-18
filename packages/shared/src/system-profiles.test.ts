import { describe, expect, it } from 'vitest';
import { prototypeImportSchema } from './prototype-import';
import { ECIDADE_BLOCK_CATEGORY, ECIDADE_WINDOW_TEMPLATE_ID } from './prototypes';
import { DEFAULT_SYSTEM_PROFILE_ID, SYSTEM_PROFILES, findSystemProfile } from './system-profiles';

describe('system profiles', () => {
  it('has e-Cidade as the default (first built-in) profile', () => {
    expect(DEFAULT_SYSTEM_PROFILE_ID).toBe('ecidade');
    expect(SYSTEM_PROFILES.map((p) => p.id)).toEqual(['ecidade']);
    expect(findSystemProfile('e-cidade')).toBeUndefined();
    expect(findSystemProfile('ECIDADE')).toMatchObject({
      name: 'e-Cidade',
      windowTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
      paletteCategory: ECIDADE_BLOCK_CATEGORY,
    });
    expect(findSystemProfile(null)).toBeUndefined();
  });
});

describe('prototypeImportSchema', () => {
  const ok = {
    formatVersion: 1,
    name: 'T',
    snapshot: { html: '<body></body>', width: 800, height: 600 },
  };

  it('accepts the minimal payload and defaults css and keepData', () => {
    const parsed = prototypeImportSchema.parse(ok);
    expect(parsed.snapshot.css).toBe('');
    expect(parsed.keepData).toBe(false);
  });

  it('rejects other format versions with a readable message', () => {
    const res = prototypeImportSchema.safeParse({ ...ok, formatVersion: 2 });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain('formatVersion');
  });
});
