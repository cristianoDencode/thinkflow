import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../../src/contexts/routing/domain/error-classifier';

describe('classifyFailure', () => {
  it.each([
    [null, 'ECONNRESET', 'network', 'connection'],
    [429, 'Rate limit reached for requests', 'rate_limited', 'connection'],
    [
      429,
      'You exceeded your current quota, please check your plan',
      'quota_exhausted',
      'connection',
    ],
    [402, 'Payment required', 'quota_exhausted', 'connection'],
    [
      400,
      'Your credit balance is too low to access the Anthropic API',
      'quota_exhausted',
      'connection',
    ],
    [401, 'Invalid API key', 'auth', 'connection'],
    [403, 'Forbidden', 'auth', 'connection'],
    [503, 'Service unavailable', 'capacity', 'connection'],
    [529, 'Overloaded', 'capacity', 'connection'],
    [500, 'The model is overloaded, try again later', 'capacity', 'connection'],
    [500, 'Internal error', 'server', 'connection'],
    [504, 'Gateway timeout', 'network', 'connection'],
    [404, 'Not found', 'model_unavailable', 'target'],
    [400, 'This model maximum context length is 8192 tokens', 'context_length', 'target'],
    [413, 'Payload too large', 'context_length', 'target'],
    [400, 'The model `foo` does not exist', 'model_unavailable', 'target'],
    [400, 'messages: field required', 'bad_request', 'fatal'],
    [422, 'Unprocessable', 'bad_request', 'fatal'],
  ] as const)('status %s "%s" → %s/%s', (status, message, reason, scope) => {
    const result = classifyFailure({ status, message });
    expect(result.reason).toBe(reason);
    expect(result.scope).toBe(scope);
  });

  it('flags daily quotas', () => {
    expect(
      classifyFailure({ status: 429, message: 'Rate limit reached: requests per day (RPD)' }).daily,
    ).toBe(true);
    expect(
      classifyFailure({ status: 429, message: 'Rate limit reached: requests per minute' }).daily,
    ).toBe(false);
  });
});

describe('isToolUnsupported', () => {
  it('detects tool-calling rejections', async () => {
    const { isToolUnsupported } =
      await import('../../src/contexts/routing/domain/error-classifier');
    expect(isToolUnsupported('`tool calling` is not supported with this model')).toBe(true);
    expect(isToolUnsupported('This model does not support tools')).toBe(true);
    expect(isToolUnsupported('model does not support function calling')).toBe(true);
    expect(isToolUnsupported('Rate limit reached')).toBe(false);
  });
});
