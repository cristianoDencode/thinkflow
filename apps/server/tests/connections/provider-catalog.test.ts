import { describe, expect, it } from 'vitest';
import { providerCatalog } from '../../src/contexts/connections/domain/provider-catalog';

const EXPECTED_IDS = [
  'openrouter',
  'groq',
  'mistral',
  'nvidia',
  'deepseek',
  'ollama',
  'lmstudio',
  'anthropic',
  'openai',
  'custom-openai',
  'custom-anthropic',
];

const REMOVED_IDS = [
  'gemini',
  'cerebras',
  'github-models',
  'siliconflow',
  'spark',
  'hunyuan',
  'qianfan',
  'longcat',
  'volcengine-ark',
  'byteplus-modelark',
];

describe('providerCatalog', () => {
  it('has unique ids', () => {
    const ids = providerCatalog.list().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers exactly the supported providers', () => {
    expect(
      providerCatalog
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual([...EXPECTED_IDS].sort());
  });

  it.each(REMOVED_IDS)('no longer registers %s', (id) => {
    expect(providerCatalog.has(id)).toBe(false);
  });

  it.each(EXPECTED_IDS)('%s has a well-formed base URL', (id) => {
    const p = providerCatalog.get(id)!;
    expect(p.baseUrl.endsWith('/')).toBe(false);
    if (p.baseUrl !== '') expect(p.baseUrl).toMatch(/^https?:\/\/[^/]+/);
    const local = id === 'ollama' || id === 'lmstudio';
    if (p.baseUrl !== '' && !local) expect(p.baseUrl).toMatch(/^https:\/\//);
    // providers without a models endpoint must offer a model to probe with
    if (p.modelsUrl === null) expect(p.suggestedModels.length).toBeGreaterThan(0);
  });
});
