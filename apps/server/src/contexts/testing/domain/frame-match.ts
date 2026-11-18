/**
 * Finds the frame of a recorded step when its URL is not the same any more: the query string holds
 * what the user typed (a parameter in the test) and some systems number their windows
 * (`/w/1/…`, `/w/2/…`), so an exact comparison fails with another data set or another run.
 */

/** Pathname with every numbered window segment (`/w/<n>`) replaced by `/w/*`. */
const NUMBERED_WINDOW = /\/w\/\d+(?=\/|$)/g;

interface Parts {
  origin: string;
  path: string;
}

function parts(url: string): Parts | null {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: u.pathname };
  } catch {
    return null;
  }
}

/**
 * How close `actual` is to the `recorded` frame URL: 0 = identical, 1 = same origin and path
 * (query/hash ignored), 2 = same path once numbered window segments are ignored; null = unrelated.
 */
export function frameMatchTier(recorded: string, actual: string): 0 | 1 | 2 | null {
  if (recorded === actual) return 0;
  const a = parts(recorded);
  const b = parts(actual);
  if (!a || !b || a.origin !== b.origin) return null;
  if (a.path === b.path) return 1;
  if (a.path.replace(NUMBERED_WINDOW, '/w/*') === b.path.replace(NUMBERED_WINDOW, '/w/*')) return 2;
  return null;
}

/**
 * Indexes of `urls` ordered by how well they match `recorded` (closest tier first, document order
 * within a tier); the frames that do not match at all follow, in document order.
 */
export function rankFrameUrls(recorded: string, urls: readonly string[]): number[] {
  const tiers = urls.map((url) => frameMatchTier(recorded, url));
  const order = urls.map((_, i) => i);
  return order.sort((i, j) => (tiers[i] ?? 3) - (tiers[j] ?? 3) || i - j);
}
