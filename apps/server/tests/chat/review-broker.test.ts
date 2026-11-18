import type { AiReviewDto, ChatStreamEvent } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_TIMEOUT_MS, ReviewBroker } from '../../src/contexts/chat/application/review-broker';

const review = (reviewId = 'r1'): AiReviewDto => ({
  reviewId,
  databaseId: 'db1',
  sql: 'select 1',
  columns: [],
});

let events: ChatStreamEvent[];
const emit = (e: ChatStreamEvent) => events.push(e);

beforeEach(() => {
  events = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('ReviewBroker', () => {
  it('announces the review and resolves with the analyst decisions', async () => {
    const broker = new ReviewBroker();
    const waiting = broker.request(review(), emit);
    expect(events).toEqual([{ type: 'ai_review', review: review() }]);
    expect(broker.size).toBe(1);

    expect(broker.answer('r1', [{ index: 0, action: 'reveal', remember: true }])).toBe(true);
    await expect(waiting).resolves.toEqual([{ index: 0, action: 'reveal', remember: true }]);
    expect(events.at(-1)).toEqual({ type: 'ai_review_closed', reviewId: 'r1', reason: 'answered' });
    expect(broker.size).toBe(0);

    // a second answer (double click, late POST) finds nothing
    expect(broker.answer('r1', [])).toBe(false);
    expect(broker.answer('nope', [])).toBe(false);
  });

  it('times out after 5 minutes with no decisions (= tokenize everything)', async () => {
    const broker = new ReviewBroker();
    const waiting = broker.request(review(), emit);
    await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS - 1);
    expect(broker.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'ai_review_closed', reviewId: 'r1', reason: 'timeout' });
    expect(broker.answer('r1', [{ index: 0, action: 'reveal', remember: false }])).toBe(false);
  });

  it('aborting the turn releases the review', async () => {
    const broker = new ReviewBroker();
    const controller = new AbortController();
    const waiting = broker.request(review(), emit, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'ai_review_closed', reviewId: 'r1', reason: 'aborted' });
    expect(broker.size).toBe(0);
    // the timer is gone too
    await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS);
    expect(events.filter((e) => e.type === 'ai_review_closed')).toHaveLength(1);
  });

  it('an already aborted signal never shows a card', async () => {
    const broker = new ReviewBroker();
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request(review(), emit, controller.signal)).resolves.toEqual([]);
    expect(events).toEqual([]);
  });

  it('keeps concurrent reviews apart', async () => {
    const broker = new ReviewBroker();
    const a = broker.request(review('a'), emit);
    const b = broker.request(review('b'), emit);
    broker.answer('b', [{ index: 1, action: 'omit', remember: false }]);
    await expect(b).resolves.toHaveLength(1);
    expect(broker.size).toBe(1);
    broker.answer('a', []);
    await expect(a).resolves.toEqual([]);
  });

  it('honors a custom timeout', async () => {
    const broker = new ReviewBroker(1000);
    const waiting = broker.request(review(), emit);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toEqual([]);
  });
});
