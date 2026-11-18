/*
 * The server renders the thumbnail PNG by itself a little after a capture / save, so the list and
 * the editor header keep looking for it briefly (every 4 s, for up to 20 s after the prototype was
 * last updated) and ask for the image with a version in the URL so the browser never shows an old
 * (or the cached 404 of a not yet rendered) picture.
 */

export const THUMB_POLL_WINDOW_MS = 20_000;
export const THUMB_POLL_EVERY_MS = 4_000;

interface ThumbSource {
  thumbnailUrl: string | null;
  updatedAt: number;
}

/** True while a thumbnail may still be on its way (null) or about to be replaced (stale). */
export const thumbnailMayChange = (p: { updatedAt: number }, now = Date.now()) =>
  now - p.updatedAt < THUMB_POLL_WINDOW_MS;

/** `refetchInterval` for a list / detail query: poll only inside the window after an update. */
export function thumbnailPollInterval(
  items: { updatedAt: number }[] | undefined,
  now = Date.now(),
): number | false {
  return items?.some((p) => thumbnailMayChange(p, now)) ? THUMB_POLL_EVERY_MS : false;
}

/**
 * Image URL with a cache-busting param (`updatedAt`; inside the polling window also the time of the
 * last fetch, since the server may replace the PNG without touching `updatedAt`). Null until the
 * server has a thumbnail: the caller keeps showing the placeholder.
 */
export function thumbnailSrc(p: ThumbSource, fetchedAt = 0, now = Date.now()): string | null {
  if (!p.thumbnailUrl) return null;
  const version =
    fetchedAt && thumbnailMayChange(p, now) ? `${p.updatedAt}-${fetchedAt}` : String(p.updatedAt);
  return `${p.thumbnailUrl}${p.thumbnailUrl.includes('?') ? '&' : '?'}v=${version}`;
}
