import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initiateDeviceAuth,
  pollDeviceAuth,
  pollDeviceAuthUntilComplete,
} from '../../oauth/device-auth.js';

const ENDPOINTS = { issuer: 'https://auth.example.test', clientId: 'client-xyz' };

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initiateDeviceAuth', () => {
  it('returns deviceAuthId, userCode, verificationUrl, and a sane interval', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, {
        device_auth_id: 'dev-123',
        user_code: 'ABCD-1234',
        interval: '7',
      }),
    );

    const result = await initiateDeviceAuth(ENDPOINTS);

    expect(result).toEqual({
      deviceAuthId: 'dev-123',
      userCode: 'ABCD-1234',
      verificationUrl: `${ENDPOINTS.issuer}/codex/device`,
      interval: 7,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${ENDPOINTS.issuer}/api/accounts/deviceauth/usercode`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ client_id: ENDPOINTS.clientId }),
      }),
    );
  });

  it('throws on a non-2xx initiation response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 503 }));
    await expect(initiateDeviceAuth(ENDPOINTS)).rejects.toThrow(/Failed to initiate/);
  });

  it('falls back to interval 5 when the server omits it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, { device_auth_id: 'd', user_code: 'c' }),
    );
    const result = await initiateDeviceAuth(ENDPOINTS);
    expect(result.interval).toBe(5);
  });
});

describe('pollDeviceAuth', () => {
  it('returns pending on 403 and 404', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    expect(await pollDeviceAuth('d', 'c', ENDPOINTS)).toEqual({ status: 'pending' });
    expect(await pollDeviceAuth('d', 'c', ENDPOINTS)).toEqual({ status: 'pending' });
  });

  it('exchanges authorization_code + code_verifier for tokens on success', async () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'acc-1' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: accessToken,
          refresh_token: 'refresh-1',
          expires_in: 1000,
        }),
      );

    const result = await pollDeviceAuth('d', 'c', ENDPOINTS);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.tokens.accessToken).toBe(accessToken);
      expect(result.tokens.refreshToken).toBe('refresh-1');
      expect(result.tokens.accountId).toBe('acc-1');
      expect(result.tokens.expires).toBeGreaterThan(Date.now());
    }

    // Verify the token-exchange call shape (form-encoded with the verifier).
    const tokenCall = fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(tokenCall?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(String(tokenCall?.body)).toContain('grant_type=authorization_code');
    expect(String(tokenCall?.body)).toContain('code_verifier=verifier');
  });

  it('returns failed when the token endpoint rejects the exchange', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' }),
      )
      .mockResolvedValueOnce(new Response('bad', { status: 400 }));

    const result = await pollDeviceAuth('d', 'c', ENDPOINTS);
    expect(result.status).toBe('failed');
  });
});

describe('pollDeviceAuthUntilComplete', () => {
  it('keeps polling on pending until success', async () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'acc-1' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 403 })) // pending
      .mockResolvedValueOnce(jsonResponse(200, { authorization_code: 'a', code_verifier: 'v' })) // poll success
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: accessToken,
          refresh_token: 'r',
          expires_in: 100,
        }),
      ); // token exchange

    const result = await pollDeviceAuthUntilComplete(
      { deviceAuthId: 'd', userCode: 'c', interval: 1 },
      { intervalMs: 0, endpoints: ENDPOINTS },
    );

    expect(result.status).toBe('success');
  });

  it('respects the abort signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await pollDeviceAuthUntilComplete(
      { deviceAuthId: 'd', userCode: 'c', interval: 1 },
      { intervalMs: 0, endpoints: ENDPOINTS, signal: ctrl.signal },
    );
    expect(result.status).toBe('failed');
  });
});
