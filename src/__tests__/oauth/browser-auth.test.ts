import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startCodexOAuthFlow, exchangeCodeManually } from '../../oauth/browser-auth.js';

const ENDPOINTS = { issuer: 'https://auth.example.test', clientId: 'client-xyz' };

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

afterEach(() => vi.restoreAllMocks());

/**
 * Find an open ephemeral port. Avoids hard-coding 1455 (which the user may
 * actually have bound) and prevents flake from collisions across parallel
 * test runs.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function extractAuthUrlState(authUrl: string): string {
  const url = new URL(authUrl);
  const state = url.searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

describe('startCodexOAuthFlow', () => {
  it('builds a PKCE authorization URL with the expected parameters', async () => {
    const callbackPort = await getFreePort();
    const flow = await startCodexOAuthFlow({ endpoints: ENDPOINTS, callbackPort, timeoutMs: 100 });
    const url = new URL(flow.authUrl);

    expect(url.origin + url.pathname).toBe(`${ENDPOINTS.issuer}/oauth/authorize`);
    expect(url.searchParams.get('client_id')).toBe(ENDPOINTS.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(0);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `http://localhost:${callbackPort}/auth/callback`,
    );
    expect(url.searchParams.get('scope')).toContain('offline_access');

    // Let the timeout fire to clean up the listener.
    await flow.waitForCompletion();
  });

  it('exchanges a callback code for tokens and resolves with the state', async () => {
    const callbackPort = await getFreePort();
    const accessToken = makeJwt({ chatgpt_account_id: 'acc-callback' });

    // Mock only the OAuth token endpoint — let the loopback callback fetch
    // pass through to the real local server we just started.
    const realFetch = globalThis.fetch.bind(globalThis);
    const tokenCalls: Array<RequestInit | undefined> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.startsWith(`${ENDPOINTS.issuer}/oauth/token`)) {
        tokenCalls.push(init as RequestInit | undefined);
        return new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: 'refresh-callback',
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return realFetch(input, init);
    });

    const flow = await startCodexOAuthFlow({ endpoints: ENDPOINTS, callbackPort, timeoutMs: 5000 });
    const state = extractAuthUrlState(flow.authUrl);

    // Simulate the browser hitting the callback URL.
    const completion = flow.waitForCompletion();
    const callbackResponse = await fetch(
      `http://127.0.0.1:${callbackPort}/auth/callback?state=${state}&code=auth-code-123`,
    );
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain('Authentication successful');

    const result = await completion;
    expect(result.success).toBe(true);
    expect(result.state?.accessToken).toBe(accessToken);
    expect(result.state?.refreshToken).toBe('refresh-callback');
    expect(result.state?.accountId).toBe('acc-callback');

    expect(tokenCalls).toHaveLength(1);
    const exchangeBody = String(tokenCalls[0]?.body);
    expect(exchangeBody).toContain('grant_type=authorization_code');
    expect(exchangeBody).toContain('code=auth-code-123');
  });

  it('rejects callbacks with a mismatched state parameter', async () => {
    const callbackPort = await getFreePort();
    const flow = await startCodexOAuthFlow({ endpoints: ENDPOINTS, callbackPort, timeoutMs: 5000 });

    const completion = flow.waitForCompletion();
    const res = await fetch(
      `http://127.0.0.1:${callbackPort}/auth/callback?state=wrong&code=irrelevant`,
    );
    expect(res.status).toBe(400);

    const result = await completion;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/state mismatch/i);
  });

  it('returns a timeout error when the user never visits the callback URL', async () => {
    const callbackPort = await getFreePort();
    const flow = await startCodexOAuthFlow({ endpoints: ENDPOINTS, callbackPort, timeoutMs: 100 });
    const result = await flow.waitForCompletion();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});

describe('exchangeCodeManually', () => {
  it('exchanges a manually-supplied code + verifier for tokens', async () => {
    const accessToken = makeJwt({});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: accessToken, refresh_token: 'r', expires_in: 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await exchangeCodeManually('the-code', 'the-verifier', { endpoints: ENDPOINTS });
    expect(result.success).toBe(true);
    expect(result.state?.accessToken).toBe(accessToken);
  });

  it('returns failure when the exchange returns a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }));
    const result = await exchangeCodeManually('c', 'v', { endpoints: ENDPOINTS });
    expect(result.success).toBe(false);
  });
});
