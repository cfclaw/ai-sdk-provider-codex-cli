import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadAPIKeyError } from '@ai-sdk/provider';
import { CodexAuthManager } from '../../direct/auth-manager.js';

const ENDPOINTS = { issuer: 'https://auth.example.test', clientId: 'client-xyz' };

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

afterEach(() => vi.restoreAllMocks());

describe('CodexAuthManager', () => {
  it('returns the cached access token when not expired', async () => {
    const manager = new CodexAuthManager({
      source: {
        state: {
          accessToken: 'a',
          refreshToken: 'r',
          accountId: 'acc',
          expires: Date.now() + 10 * 60_000,
        },
      },
      persist: false,
      endpoints: ENDPOINTS,
    });

    expect(await manager.getAccessToken()).toBe('a');
  });

  it('refreshes the token when it is within the leeway window', async () => {
    const newAccess = makeJwt({ chatgpt_account_id: 'acc-new' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: newAccess, refresh_token: 'r2', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const manager = new CodexAuthManager({
      source: {
        state: {
          accessToken: 'old',
          refreshToken: 'r1',
          accountId: 'acc-old',
          expires: Date.now() + 1000,
        },
      },
      persist: false,
      endpoints: ENDPOINTS,
      refreshLeewayMs: 60_000,
    });

    expect(await manager.getAccessToken()).toBe(newAccess);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the cached account id without refreshing when present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const manager = new CodexAuthManager({
      source: {
        state: {
          accessToken: 'a',
          refreshToken: 'r',
          accountId: 'acc-cached',
          expires: Date.now() + 60 * 60_000,
        },
      },
      persist: false,
      endpoints: ENDPOINTS,
    });
    expect(await manager.getAccountId()).toBe('acc-cached');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('extracts the account id from the JWT when not cached', async () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'acc-jwt' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const manager = new CodexAuthManager({
      source: {
        state: {
          accessToken,
          refreshToken: 'r',
          expires: Date.now() + 60 * 60_000,
        },
      },
      persist: false,
      endpoints: ENDPOINTS,
    });
    expect(await manager.getAccountId()).toBe('acc-jwt');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('attempts a one-shot refresh when the account id is missing everywhere', async () => {
    const accessToken = makeJwt({});
    const refreshedToken = makeJwt({ chatgpt_account_id: 'acc-after-refresh' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: refreshedToken, refresh_token: 'r2', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const manager = new CodexAuthManager({
      source: {
        state: {
          accessToken,
          refreshToken: 'r',
          expires: Date.now() + 60 * 60_000,
        },
      },
      persist: false,
      endpoints: ENDPOINTS,
    });

    expect(await manager.getAccountId()).toBe('acc-after-refresh');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws LoadAPIKeyError when no auth state is available', async () => {
    const manager = new CodexAuthManager({
      source: { getState: async () => null },
      persist: false,
      endpoints: ENDPOINTS,
    });
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(LoadAPIKeyError);
  });

  it('persists refreshed tokens through the supplied persister', async () => {
    const persisted: Array<unknown> = [];
    const newAccess = makeJwt({ chatgpt_account_id: 'acc-new' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: newAccess, refresh_token: 'r2', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const manager = new CodexAuthManager({
      source: {
        state: {
          accessToken: 'old',
          refreshToken: 'r1',
          expires: 0,
        },
      },
      persist: async (state) => {
        persisted.push(state);
      },
      endpoints: ENDPOINTS,
    });

    await manager.getAccessToken();
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { accessToken: string }).accessToken).toBe(newAccess);
  });

  it('coalesces concurrent refresh requests', async () => {
    const newAccess = makeJwt({ chatgpt_account_id: 'acc-new' });
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const manager = new CodexAuthManager({
      source: {
        state: { accessToken: 'old', refreshToken: 'r1', expires: 0 },
      },
      persist: false,
      endpoints: ENDPOINTS,
    });

    const a = manager.getAccessToken();
    const b = manager.getAccessToken();

    // Yield to the event loop so the auth manager's internal awaits run
    // before we assert that fetch fired exactly once.
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch?.(
      new Response(
        JSON.stringify({ access_token: newAccess, refresh_token: 'r2', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    expect(await a).toBe(newAccess);
    expect(await b).toBe(newAccess);
  });
});
