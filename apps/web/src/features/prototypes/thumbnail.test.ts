import { describe, expect, it } from 'vitest';
import { THUMB_POLL_EVERY_MS, thumbnailPollInterval, thumbnailSrc } from './thumbnail';

describe('thumbnail helpers', () => {
  it('has no src until the server has a thumbnail', () => {
    expect(thumbnailSrc({ thumbnailUrl: null, updatedAt: 1000 })).toBeNull();
  });

  it('versions the url with updatedAt (and the fetch time while it may still change)', () => {
    const p = { thumbnailUrl: '/api/prototypes/p1/thumbnail', updatedAt: 1000 };
    expect(thumbnailSrc(p, 0, 999_999)).toBe('/api/prototypes/p1/thumbnail?v=1000');
    expect(thumbnailSrc(p, 5000, 999_999)).toBe('/api/prototypes/p1/thumbnail?v=1000'); // settled
    expect(thumbnailSrc(p, 5000, 6000)).toBe('/api/prototypes/p1/thumbnail?v=1000-5000');
    expect(thumbnailSrc({ ...p, thumbnailUrl: '/t?x=1' }, 0, 999_999)).toBe('/t?x=1&v=1000');
  });

  it('polls only for a short time after an update', () => {
    const now = 100_000;
    expect(thumbnailPollInterval([{ updatedAt: now - 3000 }], now)).toBe(THUMB_POLL_EVERY_MS);
    expect(thumbnailPollInterval([{ updatedAt: now - 30_000 }], now)).toBe(false);
    expect(thumbnailPollInterval([], now)).toBe(false);
    expect(thumbnailPollInterval(undefined, now)).toBe(false);
  });
});
