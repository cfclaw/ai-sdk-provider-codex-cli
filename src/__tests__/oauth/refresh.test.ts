import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshCodexToken } from '../../oauth/refresh.js';

const ENDPOINTS = { issuer: 'https://auth.example.test', clientId: 'client-xyz' };

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

afterEach(() => vi.restoreAllMocks());

describe('refreshCodexToken', () => {
  it('exchanges the refresh token for a new access token', async () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'acc-1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'new-refresh',
          expires_in: 60,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const before = Date.now();
    const tokens = await refreshCodexToken('old-refresh', ENDPOINTS);

    expect(tokens.accessToken).toBe(accessToken);
    expect(tokens.refreshToken).toBe('new-refresh');
    expect(tokens.accountId).toBe('acc-1');
    expect(tokens.expires).toBeGreaterThanOrEqual(before + 60_000 - 50);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(String(init?.body)).toContain('grant_type=refresh_token');
    expect(String(init?.body)).toContain('refresh_token=old-refresh');
    expect(String(init?.body)).toContain(`client_id=${ENDPOINTS.clientId}`);
  });

  it('keeps the old refresh token if the server omits a new one', async () => {
    const accessToken = makeJwt({});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: accessToken, expires_in: 100 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const tokens = await refreshCodexToken('old-refresh', ENDPOINTS, 'fallback-account');
    expect(tokens.refreshToken).toBe('old-refresh');
    expect(tokens.accountId).toBe('fallback-account');
  });

  it('throws on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(refreshCodexToken('r', ENDPOINTS)).rejects.toThrow(/Token refresh failed/);
  });
});
