import { describe, expect, it } from 'vitest';
import { NoSuchModelError } from '@ai-sdk/provider';
import { createCodexDirect } from '../../direct/codex-direct-provider.js';

const SOURCE_STATE = {
  accessToken: 'a',
  refreshToken: 'r',
  accountId: 'acc-1',
  expires: Date.now() + 60 * 60_000,
};

describe('createCodexDirect', () => {
  it('returns a callable provider that produces LanguageModelV3 instances', () => {
    const provider = createCodexDirect({ auth: { state: SOURCE_STATE }, persist: false });
    const model = provider('gpt-5.3-codex');
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('codex-direct');
    expect(model.modelId).toBe('gpt-5.3-codex');
  });

  it('exposes languageModel and chat aliases that build the same kind of model', () => {
    const provider = createCodexDirect({ auth: { state: SOURCE_STATE }, persist: false });
    expect(provider.languageModel('gpt-5.3-codex').modelId).toBe('gpt-5.3-codex');
    expect(provider.chat('gpt-5.3-codex').modelId).toBe('gpt-5.3-codex');
  });

  it('throws NoSuchModelError for embedding/image model requests', () => {
    const provider = createCodexDirect({ auth: { state: SOURCE_STATE }, persist: false });
    expect(() => provider.embeddingModel('any')).toThrow(NoSuchModelError);
    expect(() => provider.imageModel('any')).toThrow(NoSuchModelError);
  });

  it('rejects construction with `new`', () => {
    const provider = createCodexDirect({ auth: { state: SOURCE_STATE }, persist: false });
    const Ctor = provider as unknown as new (modelId: string) => unknown;
    expect(() => new Ctor('gpt-5.3-codex')).toThrow(/cannot be invoked with `new`/);
  });
});
