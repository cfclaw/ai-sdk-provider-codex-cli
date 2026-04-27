/**
 * Persisted OAuth state for a Codex/ChatGPT subscription. This is the shape
 * the provider hands back from any of the auth flows and the shape the
 * `CodexDirect` language model consumes on every request.
 */
export interface CodexOAuthState {
  /** Bearer token sent on every request to chatgpt.com/backend-api. */
  accessToken: string;
  /** Refresh token used to renew the access token without re-auth. */
  refreshToken: string;
  /** Absolute expiry timestamp in epoch milliseconds. */
  expires: number;
  /**
   * ChatGPT account ID extracted from the JWT (sent as `ChatGPT-Account-Id`
   * header). Optional because some legacy stored tokens don't contain it
   * and we recover it lazily on the first request.
   */
  accountId?: string;
}

/**
 * Issuer-level OAuth constants. Exported so callers can override for
 * staging/testing, but the defaults match the published Codex CLI.
 */
export interface CodexOAuthEndpoints {
  /** Base URL for the OpenAI auth issuer (e.g. https://auth.openai.com). */
  issuer: string;
  /** OAuth client ID registered for the Codex CLI flow. */
  clientId: string;
}

export const DEFAULT_OAUTH_ENDPOINTS: CodexOAuthEndpoints = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
};
