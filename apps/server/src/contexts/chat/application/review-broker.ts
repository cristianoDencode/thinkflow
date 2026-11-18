import type {
  AiReviewClosedReason,
  AiReviewDecision,
  AiReviewDto,
  ChatStreamEvent,
} from '@thinkflow/shared';

/** The analyst has this long to answer before everything is tokenized. */
export const REVIEW_TIMEOUT_MS = 5 * 60_000;

interface Pending {
  resolve(decisions: AiReviewDecision[]): void;
}

/**
 * Rendezvous between a blocked tool call and the analyst's answer. `request` announces the review
 * on the SSE stream (`ai_review`) and waits; `answer` (POST /api/chat/reviews/:id) releases it.
 * Timeout or an aborted turn release it with NO decisions, which the data tools read as
 * "tokenize every column" — the safe default — and announce `ai_review_closed` so the card closes.
 */
export class ReviewBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number = REVIEW_TIMEOUT_MS) {}

  request(
    review: AiReviewDto,
    emit: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<AiReviewDecision[]> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve([]);
        return;
      }
      const finish = (reason: AiReviewClosedReason, decisions: AiReviewDecision[]) => {
        if (!this.pending.delete(review.reviewId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        emit({ type: 'ai_review_closed', reviewId: review.reviewId, reason });
        resolve(decisions);
      };
      const timer = setTimeout(() => finish('timeout', []), this.timeoutMs);
      const onAbort = () => finish('aborted', []);
      this.pending.set(review.reviewId, {
        resolve: (decisions) => finish('answered', decisions),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      emit({ type: 'ai_review', review });
    });
  }

  /** Releases a waiting review; false when it is unknown (already answered, timed out or aborted). */
  answer(reviewId: string, decisions: AiReviewDecision[]): boolean {
    const entry = this.pending.get(reviewId);
    if (!entry) return false;
    entry.resolve(decisions);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }
}
