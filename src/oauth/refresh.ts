import type { CodexOAuthEndpoints, CodexOAuthState } from './types.js';
import { DEFAULT_OAUTH_ENDPOINTS } from './types.js';
import { extractAccountId } from './jwt.js';

/**
 * Exchange a refresh token for a fresh access token. Returns the full new
 * `CodexOAuthState`, including a re-derived `accountId` (in case the new
 * token's claims surface it where the previous one did not).
 *
 * Throws on non-2xx responses; callers should catch and surface a clear
 * "re-authentication required" error to the user.
 */
export async function refreshCodexToken(
  refreshToken: string,
  endpoints: CodexOAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS,
  fallbackAccountId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexOAuthState> {
  const response = await fetchImpl(`${endpoints.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: endpoints.clientId,
      // Some token endpoints require the original scopes; sending them on
      // refresh is harmless and matches what the Codex CLI does.
      scope: 'openid profile email offline_access',
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token refresh failed: ${response.status}${text ? ` — ${text}` : ''}`);
  }

  const tokens = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!tokens.access_token) {
    throw new Error('Token refresh response missing access_token');
  }

  return {
    accessToken: tokens.access_token,
    // OpenAI rotates refresh tokens — keep the new one if returned, otherwise
    // hold onto the existing one (some servers omit it on refresh).
    refreshToken: tokens.refresh_token ?? refreshToken,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens.access_token, tokens.id_token) ?? fallbackAccountId,
  };
}
