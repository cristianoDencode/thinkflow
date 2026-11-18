import {
  detectMenuPaths,
  isStructuralStep,
  MENU_PATH_SEPARATOR,
  type TestStep,
} from '@thinkflow/shared';

/*
 * Pure helpers of "Protótipo" (capture of the current screen while recording): which frame holds
 * the routine, which step the screen belongs to and where in the menu it was reached.
 */

/** A frame (iframe) found inside another, as measured in its parent. */
export interface FrameCandidate {
  /** Opaque handle of the caller. */
  index: number;
  /** Rendered area in px². */
  area: number;
  /** Not `display:none`, not hidden, with a size. */
  visible: boolean;
  url: string;
}

/** A child must cover this share of its parent's window to count as "the routine inside it". */
const MIN_CHILD_SHARE = 0.25;

/**
 * The e-Cidade desktop shows each routine inside nested iframes (a window wrapper that holds the
 * routine's own frame). From the frame the person interacted with, goes down into the biggest
 * visible child that fills most of it; `null` when there is none (this frame is the routine).
 */
export function pickRoutineChild(
  parentArea: number,
  children: readonly FrameCandidate[],
): FrameCandidate | null {
  let best: FrameCandidate | null = null;
  for (const child of children) {
    if (!child.visible || !child.url || child.url.startsWith('about:')) continue;
    if (parentArea > 0 && child.area / parentArea < MIN_CHILD_SHARE) continue;
    if (!best || child.area > best.area) best = child;
  }
  return best;
}

/**
 * The e-Cidade desktop opens each routine in a window: an iframe whose page
 * (`/w/N/extension/desktop/window/index/?action=<routine>.php`) wraps the routine's own frame and
 * the status bar frame (`…/window/bottom`). The wrapper is what "the screen" is on the user's eyes.
 */
const WINDOW_FRAME_URL = /\/extension\/desktop\/window\/index(?:[/?#.]|$)/i;

export const isWindowFrameUrl = (url: string): boolean => WINDOW_FRAME_URL.test(url);

/** A window wrapper frame as measured in the page that holds it. */
export interface WindowCandidate extends FrameCandidate {
  /** Nothing covers the middle of its box: it is the window in front. */
  topmost: boolean;
}

/**
 * Which window to capture when the user last worked on the desktop itself (no routine frame to
 * walk up from): the visible window in front, then the biggest. `null` when there is none.
 */
export function pickWindowFrame(candidates: readonly WindowCandidate[]): WindowCandidate | null {
  let best: WindowCandidate | null = null;
  for (const c of candidates) {
    if (!c.visible || !isWindowFrameUrl(c.url)) continue;
    if (
      !best ||
      (c.topmost && !best.topmost) ||
      (c.topmost === best.topmost && c.area > best.area)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * From the chain of frame addresses `start … top` (the frame the user worked in first), the index
 * of the nearest one that is a window wrapper; `-1` when the chain holds none.
 */
export function windowIndexInChain(urls: readonly string[]): number {
  return urls.findIndex(isWindowFrameUrl);
}

/** The step the screen belongs to: the last one that is not a note or a use-case divider. */
export function currentStepOf(steps: readonly TestStep[]): TestStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!isStructuralStep(steps[i]!)) return steps[i]!;
  }
  return null;
}

/**
 * "DB:FINANCEIRO > Empenho > Consultas > Consulta Empenho": the menu run nearest before (or at)
 * `stepId`; `null` when the session recorded no menu navigation by then.
 */
export function menuPathBefore(steps: readonly TestStep[], stepId: string | null): string | null {
  const limit = stepId ? steps.findIndex((s) => s.id === stepId) : steps.length - 1;
  if (limit < 0) return null;
  const order = new Map(steps.map((s, i) => [s.id, i]));
  let found: string[] | null = null;
  for (const suggestion of detectMenuPaths(steps)) {
    if ((order.get(suggestion.stepId) ?? Infinity) <= limit) found = suggestion.path;
  }
  return found ? found.join(MENU_PATH_SEPARATOR) : null;
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;

/** Makes the `url()`s of a stylesheet fetched outside the page absolute (relative to the sheet). */
export function absolutizeCssUrls(css: string, base: string): string {
  return css.replace(CSS_URL, (whole, dq?: string, sq?: string, bare?: string) => {
    const raw = (dq ?? sq ?? bare ?? '').trim();
    if (!raw || /^(data:|#|about:|blob:)/i.test(raw)) return whole;
    try {
      return `url("${new URL(raw, base).href.replace(/"/g, '%22')}")`;
    } catch {
      return whole;
    }
  });
}
