import { describe, expect, it } from 'vitest';
import { isAutoModel, pickAutoModel } from '../../src/contexts/routing/domain/auto-model';

describe('pickAutoModel', () => {
  it('prefers a strong chat model and skips non-chat ones', () => {
    expect(
      pickAutoModel(['whisper-large-v3', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile']),
    ).toBe('llama-3.3-70b-versatile');
  });
  it('skips excluded models', () => {
    expect(pickAutoModel(['a-70b', 'b-70b'], ['a-70b'])).toBe('b-70b');
  });
  it('returns null when nothing is usable', () => {
    expect(pickAutoModel(['text-embedding-3'])).toBeNull();
  });
  it('detects auto', () => {
    expect(isAutoModel('auto')).toBe(true);
    expect(isAutoModel('llama')).toBe(false);
  });
});

const GROQ_MODELS = [
  'allam-2-7b',
  'canopylabs/orpheus-arabic-saudi',
  'canopylabs/orpheus-v1-english',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-guard-4-12b',
  'moonshotai/kimi-k2-instruct',
  'openai/gpt-oss-120b',
  'qwen/qwen3-32b',
  'whisper-large-v3',
  'playai-tts',
  'distil-whisper-large-v3-en',
];

describe('pickAutoModel (text chat only)', () => {
  it('never picks speech/voice/audio/image/guard models', () => {
    let remaining = [...GROQ_MODELS];
    const picked: string[] = [];
    for (;;) {
      const m = pickAutoModel(remaining, picked);
      if (!m) break;
      picked.push(m);
      remaining = remaining.filter((x) => x !== m);
    }
    expect(picked).not.toContain('canopylabs/orpheus-v1-english');
    expect(picked).not.toContain('playai-tts');
    expect(picked).not.toContain('whisper-large-v3');
    expect(picked).not.toContain('meta-llama/llama-guard-4-12b');
    expect(picked[0]).toBe('llama-3.3-70b-versatile');
    expect(picked.slice(0, 3)).toEqual([
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'qwen/qwen3-32b',
    ]);
  });
  it('excludes image, realtime and embedding models', () => {
    expect(
      pickAutoModel(['dall-e-3', 'gpt-4o-realtime-preview', 'flux-1-dev', 'sonic-2', 'rerank-v3']),
    ).toBeNull();
  });
  it('does not guess for tool requests when nothing is preferred', () => {
    expect(pickAutoModel(['allam-2-7b', 'foo-1b'], [], true)).toBeNull();
    expect(pickAutoModel(['allam-2-7b', 'foo-1b'])).toBe('allam-2-7b');
  });
  it('prefers larger-looking models in the non-tool fallback', () => {
    expect(pickAutoModel(['alpha-3b', 'beta-14b', 'gamma-7b'])).toBe('beta-14b');
  });
});

describe('resolveModel auto', () => {
  it('expands to every connected provider with the auto model', async () => {
    const { resolveModel } = await import('../../src/contexts/routing/domain/model-resolver');
    const r = resolveModel('auto', {
      findCombo: () => undefined,
      hasProvider: () => true,
      hasConnectionsFor: () => true,
      connectedProviders: () => ['groq', 'mistral'],
      aliases: { default: '', opus: '', sonnet: '', haiku: '' },
      sequence: 0,
    });
    expect(r.targets).toEqual([
      { providerId: 'groq', model: 'auto' },
      { providerId: 'mistral', model: 'auto' },
    ]);
  });
});

describe('classifyFailure (limits)', () => {
  it('treats Groq TPM 413 as context_length, not quota', async () => {
    const { classifyFailure } = await import('../../src/contexts/routing/domain/error-classifier');
    const r = classifyFailure({
      status: 413,
      message:
        'Request too large for model x on tokens per minute (TPM): Limit 8000. Upgrade at billing',
    });
    expect(r.reason).toBe('context_length');
  });
  it('treats per-minute 429 as rate_limited even when billing is mentioned', async () => {
    const { classifyFailure } = await import('../../src/contexts/routing/domain/error-classifier');
    expect(
      classifyFailure({
        status: 429,
        message: 'Rate limit reached (TPM). try again in 37s. billing',
      }).reason,
    ).toBe('rate_limited');
  });
  it('treats Gemini "limit: 0, model: x" as a model problem, not a dead connection', async () => {
    const { classifyFailure } = await import('../../src/contexts/routing/domain/error-classifier');
    const r = classifyFailure({
      status: 429,
      message: 'You exceeded your current quota. limit: 0, model: gemini-omni-1.1-flash, per day',
    });
    expect(r).toMatchObject({ reason: 'model_unavailable', scope: 'target' });
  });
});

describe('pickAutoModel (Gemini)', () => {
  const GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-live-preview',
    'gemini-2.5-flash-native-audio-preview',
    'gemini-2.5-computer-use-preview',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-3.8-flash-lite',
    'gemini-3.10-flash-preview',
    'gemini-2.5-flash-image',
  ];
  it('excludes live, bidirectional, native-audio and computer-use models', () => {
    let remaining = [...GEMINI_MODELS];
    const picked: string[] = [];
    for (;;) {
      const m = pickAutoModel(remaining);
      if (!m) break;
      picked.push(m);
      remaining = remaining.filter((x) => x !== m);
    }
    expect(picked).not.toContain('gemini-3.1-flash-live-preview');
    expect(picked).not.toContain('gemini-2.5-flash-native-audio-preview');
    expect(picked).not.toContain('gemini-2.5-computer-use-preview');
    expect(picked).not.toContain('gemini-2.5-flash-image');
    expect(pickAutoModel(['gemini-live-2.5-flash', 'models/foo-live'])).toBeNull();
  });
  it('picks the newest stable flash, ahead of older versions and previews', () => {
    expect(pickAutoModel(GEMINI_MODELS)).toBe('gemini-3.8-flash');
    expect(pickAutoModel(GEMINI_MODELS, ['gemini-3.8-flash'])).toBe('gemini-3.5-flash');
  });
  it('uses a preview only when no stable flash is left, and -lite only as a last resort', () => {
    const left = ['gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-3.10-flash-preview'];
    expect(pickAutoModel(left)).toBe('gemini-3.10-flash-preview');
    expect(pickAutoModel(['gemini-2.5-flash-lite', 'gemini-3.8-flash-lite'])).toBe(
      'gemini-2.5-flash-lite',
    );
  });
  it('still keeps non-text models out of tool requests', () => {
    expect(pickAutoModel(['gemini-3.1-flash-live-preview'], [], true)).toBeNull();
  });
});
