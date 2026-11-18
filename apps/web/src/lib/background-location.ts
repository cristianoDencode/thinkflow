import type { Location } from 'react-router';

/** Router state that marks a navigation as "open this page as a modal over `backgroundLocation`". */
export interface BackgroundState {
  backgroundLocation?: Location;
}

/** The location the modal was opened over, if the given location carries one. */
export function readBackground(location: Pick<Location, 'state'>): Location | null {
  const candidate = (location.state as BackgroundState | null)?.backgroundLocation;
  return candidate && typeof candidate.pathname === 'string' ? candidate : null;
}

/** State to attach to a link/navigate so the target opens as a modal over the current screen. */
export function modalState(location: Location): BackgroundState {
  return { backgroundLocation: readBackground(location) ?? location };
}

/** Paths compare equal ignoring a trailing slash. */
export function samePath(a: string, b: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  return strip(a) === strip(b);
}
