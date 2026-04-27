import type { CodexAuthSource, OAuthStatePersister } from './auth-manager.js';
import type { CodexOAuthEndpoints } from '../oauth/types.js';
import type { Logger } from '../types-shared.js';

/**
 * Per-call settings for `codexDirect`. These map onto fields in the Codex
 * Responses API request body.
 */
export interface CodexDirectSettings {
  /** Override the system instruction. Otherwise system messages from the prompt are used. */
  defaultInstructions?: string;
  /** Identifier sent as the `originator` header (and used as the request originator). Defaults to `ai-sdk-provider-codex-cli`. */
  originator?: string;
  /** Custom logger; pass `false` to disable logging. */
  logger?: Logger | false;
  /** Enable verbose (debug/info) log output. */
  verbose?: boolean;
}

export interface CodexDirectProviderSettings {
  /** Where to obtain OAuth tokens from. Defaults to `~/.codex/auth.json`. */
  auth?: CodexAuthSource;
  /** Persist refreshed tokens. Defaults to writing back to the source auth.json. Pass `false` to disable. */
  persist?: OAuthStatePersister | false;
  /** Override the OAuth issuer / client id (for testing). */
  endpoints?: CodexOAuthEndpoints;
  /** Override the ChatGPT backend base URL (default https://chatgpt.com/backend-api). */
  baseUrl?: string;
  /** Custom `fetch` implementation, mainly for tests. */
  fetch?: typeof fetch;
  /** Default per-model settings applied unless overridden at the call site. */
  defaultSettings?: CodexDirectSettings;
}

/**
 * Provider options consumed via `providerOptions['codex-direct']` on a
 * generate/stream call. Lets callers tweak request-level fields per-call.
 */
export interface CodexDirectProviderOptions {
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
  textVerbosity?: 'low' | 'medium' | 'high';
  /** Override `store` — defaults to `false` (stateless). */
  store?: boolean;
}
