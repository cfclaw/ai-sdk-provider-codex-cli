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
  /**
   * Override `store` — defaults to `false` (stateless). Set to `true` when
   * using `previousResponseId` so the server retains conversation state.
   */
  store?: boolean;
  /**
   * Continue a server-side thread by passing a previous response id (the
   * value bubbled up via `providerMetadata['codex-direct'].responseId` on a
   * prior turn). When set, only the new user input needs to be sent —
   * the server replays prior turns from its own store.
   *
   * Requires `store: true` on the prior request.
   */
  previousResponseId?: string;
  /**
   * Extra `include` flags forwarded to the Responses API. We always add
   * `'reasoning.encrypted_content'` to enable cross-turn reasoning state;
   * any values listed here are merged with that.
   */
  include?: string[];
}

/**
 * Provider metadata bubbled up via `providerMetadata['codex-direct']` on
 * generated content blocks and the final `finish` event. Callers can use
 * `responseId` as a `previousResponseId` on follow-up turns, and pass
 * `encryptedContent` back through reasoning blocks to maintain reasoning
 * state across tool loops.
 */
export interface CodexDirectProviderMetadata {
  /** Server-issued response id (matches OpenAI usage logs). */
  responseId?: string;
  /** Item id of a reasoning block, when applicable. */
  itemId?: string;
  /** Encrypted reasoning state to echo back on the next turn. */
  encryptedContent?: string;
}
