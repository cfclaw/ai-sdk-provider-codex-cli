/**
 * Decode a JWT payload without verifying the signature. Returns null if the
 * input is not a structurally valid JWT (three base64url segments) or the
 * payload is not valid JSON.
 *
 * We never trust these claims for authorization — we only read them to surface
 * the ChatGPT account ID that the backend requires as a request header.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the ChatGPT account ID from a token's claims. Different OpenAI
 * token versions surface the same value at different paths, so we check the
 * known locations in priority order:
 *   1. `chatgpt_account_id` (top-level)
 *   2. `https://api.openai.com/auth.chatgpt_account_id` (namespaced claim)
 *   3. `organizations[0].id` (older issuance format)
 *
 * Both the id_token (when present) and the access_token are inspected; the
 * id_token usually contains richer claims so we try it first.
 */
export function extractAccountId(accessToken: string, idToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;

    const top = payload['chatgpt_account_id'];
    if (typeof top === 'string' && top.length > 0) return top;

    const namespaced = payload['https://api.openai.com/auth'];
    if (namespaced && typeof namespaced === 'object' && !Array.isArray(namespaced)) {
      const nested = (namespaced as Record<string, unknown>)['chatgpt_account_id'];
      if (typeof nested === 'string' && nested.length > 0) return nested;
    }

    const orgs = payload['organizations'];
    if (Array.isArray(orgs) && orgs.length > 0) {
      const first = orgs[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        const id = (first as Record<string, unknown>)['id'];
        if (typeof id === 'string' && id.length > 0) return id;
      }
    }
  }
  return undefined;
}

/**
 * Read the `exp` (expires-at) claim from a JWT and return it as epoch
 * milliseconds. Returns `undefined` if the token isn't a structurally
 * valid JWT or has no `exp` claim. Useful for healthchecks that want to
 * report when an access token will lapse without making a network call.
 */
export function getJwtExpiryMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}
