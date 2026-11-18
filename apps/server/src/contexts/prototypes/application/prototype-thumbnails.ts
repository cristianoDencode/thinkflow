import { NotFoundError } from '../../../shared/kernel/errors';
import type { PrototypeRenderService } from './prototype-render-service';
import type { PrototypeService } from './prototype-service';

/** A burst of edits (the editor saves often) renders once, this long after the last one. */
export const THUMBNAIL_DEBOUNCE_MS = 2000;
/** A version saved while a render runs asks for another render; this bounds the chase. */
const MAX_CHASES = 3;

export interface PrototypeThumbnailsDeps {
  prototypes: Pick<PrototypeService, 'require'>;
  render: Pick<PrototypeRenderService, 'render'>;
  debounceMs?: number;
  /** Failures are only reported: a missing thumbnail never fails the request that saved the version. */
  onError?: (err: unknown) => void;
}

/**
 * Keeps the PNG of every prototype up to date in the background, so the list shows the image
 * without anyone clicking "Gerar imagem". `schedule` returns at once; the render (the same one the
 * button runs, cached per version) happens after a quiet period per prototype.
 */
export class PrototypeThumbnails {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private closed = false;

  constructor(private readonly deps: PrototypeThumbnailsDeps) {
    this.debounceMs = deps.debounceMs ?? THUMBNAIL_DEBOUNCE_MS;
  }

  /** Never throws and never waits for the render. */
  schedule(id: string): void {
    if (this.closed) return;
    const pending = this.timers.get(id);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.run(id);
    }, this.debounceMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  /** Drops what is waiting (shutdown); a render already running finishes on its own. */
  stop(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async run(id: string): Promise<void> {
    try {
      for (let chase = 0; chase < MAX_CHASES && !this.closed; chase++) {
        const result = await this.deps.render.render(id);
        const current = await this.deps.prototypes.require(id);
        if (result.renderedVersionId === current.currentVersionId) return;
      }
    } catch (err) {
      if (err instanceof NotFoundError) return; // deleted meanwhile
      this.deps.onError?.(err);
    }
  }
}
