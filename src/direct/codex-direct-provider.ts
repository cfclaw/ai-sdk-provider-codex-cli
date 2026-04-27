import type { LanguageModelV3, ProviderV3 } from '@ai-sdk/provider';
import { NoSuchModelError } from '@ai-sdk/provider';
import { CodexAuthManager } from './auth-manager.js';
import { CodexDirectLanguageModel } from './codex-direct-language-model.js';
import type { CodexDirectProviderSettings, CodexDirectSettings } from './types.js';
import type { CodexModelId } from '../types-shared.js';

export interface CodexDirectProvider extends ProviderV3 {
  (modelId: CodexModelId, settings?: CodexDirectSettings): LanguageModelV3;
  languageModel(modelId: CodexModelId, settings?: CodexDirectSettings): LanguageModelV3;
  chat(modelId: CodexModelId, settings?: CodexDirectSettings): LanguageModelV3;
  /** Imperatively refresh the cached OAuth state from disk / source. */
  refreshAuth(): Promise<void>;
  embeddingModel(modelId: string): never;
  imageModel(modelId: string): never;
}

/**
 * Create a Codex provider that talks directly to the ChatGPT backend over
 * OAuth — no `codex` CLI binary required. Tokens are read from the same
 * `~/.codex/auth.json` the CLI writes by default, so existing logins
 * "just work".
 *
 * Pair with `initiateDeviceAuth` / `startCodexOAuthFlow` from this package
 * to implement a login flow when there's no pre-existing auth.json.
 */
export function createCodexDirect(options: CodexDirectProviderSettings = {}): CodexDirectProvider {
  const authManager = new CodexAuthManager({
    source: options.auth,
    persist: options.persist,
    endpoints: options.endpoints,
  });

  const createModel = (
    modelId: CodexModelId,
    settings: CodexDirectSettings = {},
  ): LanguageModelV3 => {
    const merged: CodexDirectSettings = { ...options.defaultSettings, ...settings };
    return new CodexDirectLanguageModel({
      modelId,
      authManager,
      settings: merged,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    });
  };

  const provider = Object.assign(
    function (modelId: CodexModelId, settings?: CodexDirectSettings) {
      if (new.target) {
        throw new Error('createCodexDirect provider cannot be invoked with `new`.');
      }
      return createModel(modelId, settings);
    },
    { specificationVersion: 'v3' as const },
  ) as CodexDirectProvider;

  provider.languageModel = createModel;
  provider.chat = createModel;
  provider.refreshAuth = async () => {
    await authManager.refreshState();
  };
  provider.embeddingModel = ((modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  }) as never;
  provider.imageModel = ((modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  }) as never;

  return provider;
}

/**
 * Convenience instance for the common case of "use whatever's in
 * ~/.codex/auth.json". For custom auth sources, use `createCodexDirect`.
 */
export const codexDirect: CodexDirectProvider = createCodexDirect();
