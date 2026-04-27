import { LoadAPIKeyError } from '@ai-sdk/provider';
import type { CodexOAuthEndpoints, CodexOAuthState } from '../oauth/types.js';
import { DEFAULT_OAUTH_ENDPOINTS } from '../oauth/types.js';
import { extractAccountId } from '../oauth/jwt.js';
import { refreshCodexToken } from '../oauth/refresh.js';
import { loadCodexAuth, saveCodexAuth } from '../oauth/auth-store.js';

/**
 * Callback the consumer can supply to persist refreshed tokens (e.g. to
 * `~/.codex/auth.json` or a database). The default implementation writes
 * back to the same auth.json the Codex CLI uses.
 */
export type OAuthStatePersister = (state: CodexOAuthState) => Promise<void>;

/**
 * Source from which the auth manager should obtain its initial state.
 *
 *  - `state`: an in-memory `CodexOAuthState` (from your own UI / DB).
 *  - `getState`: an async function returning the latest state on demand.
 *  - `authFilePath`: read from `~/.codex/auth.json` (or a custom path).
 *  - default: read from the standard `~/.codex/auth.json`.
 */
export type CodexAuthSource =
  | { state: CodexOAuthState }
  | { getState: () => Promise<CodexOAuthState | null> }
  | { authFilePath: string };

export interface CodexAuthManagerOptions {
  source?: CodexAuthSource;
  /** Override how refreshed tokens are persisted. Set `false` to disable. */
  persist?: OAuthStatePersister | false;
  /** Override the OAuth issuer/client_id (mainly for tests). */
  endpoints?: CodexOAuthEndpoints;
  /** Refresh tokens this many ms before they expire (default 60s). */
  refreshLeewayMs?: number;
}

const DEFAULT_REFRESH_LEEWAY_MS = 60_000;

/**
 * Manages the OAuth state for a single `CodexDirect` model instance:
 *   - lazily loads from `~/.codex/auth.json` on first use
 *   - refreshes the access token shortly before expiry
 *   - persists rotated tokens back to disk
 *   - recovers the `accountId` (required as a request header) on demand
 *
 * Concurrent calls share a single in-flight refresh promise so we never
 * race two refreshes against each other.
 */
export class CodexAuthManager {
  private readonly source: CodexAuthSource;
  private readonly persist: OAuthStatePersister | null;
  private readonly endpoints: CodexOAuthEndpoints;
  private readonly refreshLeewayMs: number;

  private state: CodexOAuthState | null = null;
  private inflightRefresh: Promise<CodexOAuthState> | null = null;
  private accountIdRecoveryAttempted = false;

  constructor(options: CodexAuthManagerOptions = {}) {
    this.source = options.source ?? { authFilePath: '' };
    this.endpoints = options.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
    this.refreshLeewayMs = options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;

    if (options.persist === false) {
      this.persist = null;
    } else if (typeof options.persist === 'function') {
      this.persist = options.persist;
    } else if ('authFilePath' in this.source) {
      const path = this.source.authFilePath;
      this.persist = (state) => saveCodexAuth(state, path || undefined);
    } else {
      this.persist = null;
    }
  }

  /**
   * Returns a usable access token, refreshing if needed. Call this before
   * every request. Cheap when the token is still valid (just an in-memory
   * timestamp check).
   */
  async getAccessToken(): Promise<string> {
    const state = await this.ensureState();
    if (this.isExpired(state)) {
      const refreshed = await this.refreshLocked(state);
      return refreshed.accessToken;
    }
    return state.accessToken;
  }

  /**
   * Returns the ChatGPT account ID required by the backend as a request
   * header. Tries (in order): cached state → JWT extraction → one-shot
   * refresh of the token (in case the server issues a richer JWT now).
   */
  async getAccountId(): Promise<string> {
    let state = await this.ensureState();

    if (state.accountId) return state.accountId;

    const fromJwt = extractAccountId(state.accessToken);
    if (fromJwt) {
      state = { ...state, accountId: fromJwt };
      this.state = state;
      return fromJwt;
    }

    if (!this.accountIdRecoveryAttempted) {
      this.accountIdRecoveryAttempted = true;
      const refreshed = await this.refreshLocked(state);
      if (refreshed.accountId) return refreshed.accountId;
    }

    throw new LoadAPIKeyError({
      message:
        'Cannot determine ChatGPT account ID from OAuth token. Try `codex login` again to obtain a fresh token.',
    });
  }

  /** Force-load (or reload) the underlying auth state. */
  async refreshState(): Promise<CodexOAuthState> {
    this.state = null;
    return this.ensureState();
  }

  /** Read-only snapshot of the current state, primarily for diagnostics. */
  snapshot(): CodexOAuthState | null {
    return this.state ? { ...this.state } : null;
  }

  private isExpired(state: CodexOAuthState): boolean {
    return state.expires <= Date.now() + this.refreshLeewayMs;
  }

  private async ensureState(): Promise<CodexOAuthState> {
    if (this.state) return this.state;

    if ('state' in this.source) {
      this.state = { ...this.source.state };
      return this.state;
    }

    if ('getState' in this.source) {
      const loaded = await this.source.getState();
      if (!loaded) {
        throw new LoadAPIKeyError({
          message:
            'No Codex OAuth state available. Run `codex login` or complete the device-auth flow first.',
        });
      }
      this.state = { ...loaded };
      return this.state;
    }

    const loaded = await loadCodexAuth(this.source.authFilePath || undefined);
    if (!loaded) {
      throw new LoadAPIKeyError({
        message:
          'Codex auth file not found or missing OAuth tokens. Run `codex login` or complete the device-auth flow first.',
      });
    }
    this.state = loaded;
    return this.state;
  }

  private async refreshLocked(current: CodexOAuthState): Promise<CodexOAuthState> {
    if (this.inflightRefresh) return this.inflightRefresh;

    const promise = (async () => {
      if (!current.refreshToken) {
        throw new LoadAPIKeyError({
          message: 'Codex OAuth state is missing a refresh token; re-authentication required.',
        });
      }

      let next: CodexOAuthState;
      try {
        next = await refreshCodexToken(current.refreshToken, this.endpoints, current.accountId);
      } catch (err) {
        throw new LoadAPIKeyError({
          message: `Codex OAuth token refresh failed (${err instanceof Error ? err.message : String(err)}). Re-authentication required.`,
        });
      }

      this.state = next;
      this.accountIdRecoveryAttempted = false;

      if (this.persist) {
        try {
          await this.persist(next);
        } catch {
          // Persistence is best-effort — don't fail the request if disk
          // writes blow up. The next process start will read stale tokens
          // and refresh again, which is correct behavior.
        }
      }

      return next;
    })().finally(() => {
      this.inflightRefresh = null;
    });

    this.inflightRefresh = promise;
    return promise;
  }
}
