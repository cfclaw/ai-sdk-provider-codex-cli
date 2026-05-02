/**
 * Codex device-code authorization flow.
 *
 * Uses OpenAI's device authorization endpoint — no browser redirects, no
 * localhost callback server. Suitable for headless / remote / IPC contexts
 * where opening a browser back to the host is not possible.
 *
 * Flow:
 *   1. POST /api/accounts/deviceauth/usercode → device_auth_id + user_code
 *   2. Show the user_code and verification URL to the user
 *   3. Poll POST /api/accounts/deviceauth/token until the user completes auth
 *   4. Exchange the returned authorization_code for access + refresh tokens
 *      via /oauth/token (PKCE-style with the verifier the server returned)
 */

import type { CodexOAuthEndpoints, CodexOAuthState } from './types.js';
import { DEFAULT_OAUTH_ENDPOINTS } from './types.js';
import { extractAccountId } from './jwt.js';
import { makeProxyAwareFetch } from '../direct/proxy.js';

const USER_AGENT = 'ai-sdk-provider-codex-direct';

/**
 * Lazily-built proxy-aware fetch shared by the auth helpers. Constructed on
 * first use so importing this module never touches process.env eagerly.
 */
let proxyAwareFetch: typeof fetch | undefined;
function getDefaultFetch(): typeof fetch {
  if (!proxyAwareFetch) proxyAwareFetch = makeProxyAwareFetch();
  return proxyAwareFetch;
}

/**
 * Result handed back to the caller after `initiateDeviceAuth`. The caller
 * is responsible for showing `userCode` + `verificationUrl` to the user
 * and then polling with `deviceAuthId` and `userCode`.
 */
export interface DeviceAuthInitResult {
  deviceAuthId: string;
  userCode: string;
  /** URL the user should visit (e.g. https://auth.openai.com/codex/device). */
  verificationUrl: string;
  /** Server-recommended polling interval in seconds. */
  interval: number;
}

export type DeviceAuthPollResult =
  | { status: 'pending' }
  | { status: 'success'; tokens: CodexOAuthState }
  | { status: 'failed'; error: string };

/**
 * Begin the device-code flow. Returns a code and a verification URL the user
 * must visit; subsequently poll with `pollDeviceAuth(deviceAuthId, userCode)`.
 */
export async function initiateDeviceAuth(
  endpoints: CodexOAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS,
  fetchImpl: typeof fetch = getDefaultFetch(),
): Promise<DeviceAuthInitResult> {
  const response = await fetchImpl(`${endpoints.issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: endpoints.clientId }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Failed to initiate device authorization: ${response.status}${text ? ` — ${text}` : ''}`,
    );
  }

  const data = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string | number;
  };

  if (!data.device_auth_id || !data.user_code) {
    throw new Error('Device authorization response missing required fields');
  }

  const intervalRaw =
    typeof data.interval === 'string' ? parseInt(data.interval, 10) : data.interval;
  const interval =
    typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? Math.max(intervalRaw, 1)
      : 5;

  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: `${endpoints.issuer}/codex/device`,
    interval,
  };
}

/**
 * Poll the device auth token endpoint a single time. Most callers should
 * wrap this in a loop honoring the `interval` returned by `initiateDeviceAuth`
 * — see `pollDeviceAuthUntilComplete` for that.
 *
 * The OpenAI server returns 403/404 while the user hasn't yet completed
 * the verification step, which we map to `{ status: 'pending' }`.
 */
export async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string,
  endpoints: CodexOAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS,
  fetchImpl: typeof fetch = getDefaultFetch(),
): Promise<DeviceAuthPollResult> {
  const pollResponse = await fetchImpl(`${endpoints.issuer}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });

  if (pollResponse.status === 403 || pollResponse.status === 404) {
    return { status: 'pending' };
  }

  if (!pollResponse.ok) {
    const text = await pollResponse.text().catch(() => '');
    return {
      status: 'failed',
      error: `Device auth poll failed: ${pollResponse.status}${text ? ` — ${text}` : ''}`,
    };
  }

  const data = (await pollResponse.json()) as {
    authorization_code?: string;
    code_verifier?: string;
  };

  if (!data.authorization_code || !data.code_verifier) {
    return {
      status: 'failed',
      error: 'Device auth response missing authorization_code/code_verifier',
    };
  }

  const tokenResponse = await fetchImpl(`${endpoints.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: data.authorization_code,
      redirect_uri: `${endpoints.issuer}/deviceauth/callback`,
      client_id: endpoints.clientId,
      code_verifier: data.code_verifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text().catch(() => '');
    return {
      status: 'failed',
      error: `Token exchange failed: ${tokenResponse.status}${text ? ` — ${text}` : ''}`,
    };
  }

  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!tokens.access_token || !tokens.refresh_token) {
    return { status: 'failed', error: 'Token response missing required fields' };
  }

  return {
    status: 'success',
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(tokens.access_token, tokens.id_token),
    },
  };
}

export interface PollUntilCompleteOptions {
  /** Override the polling interval (ms). Defaults to `init.interval * 1000`. */
  intervalMs?: number;
  /** Max time to wait before giving up. Defaults to 15 minutes. */
  timeoutMs?: number;
  /** Optional abort signal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Custom endpoints (mainly useful for tests). */
  endpoints?: CodexOAuthEndpoints;
  /** Custom fetch implementation; defaults to a proxy-aware fetch. */
  fetch?: typeof fetch;
}

/**
 * Convenience helper that polls until the user completes the flow, the
 * timeout elapses, or the abort signal fires. Returns the same discriminated
 * union as `pollDeviceAuth`, with an additional `'failed'` for timeout/abort.
 */
export async function pollDeviceAuthUntilComplete(
  init: Pick<DeviceAuthInitResult, 'deviceAuthId' | 'userCode' | 'interval'>,
  options: PollUntilCompleteOptions = {},
): Promise<DeviceAuthPollResult> {
  const intervalMs = options.intervalMs ?? init.interval * 1000;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const endpoints = options.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
  const fetchImpl = options.fetch ?? getDefaultFetch();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (options.signal?.aborted) {
      return { status: 'failed', error: 'Device authorization aborted' };
    }
    if (Date.now() > deadline) {
      return { status: 'failed', error: 'Device authorization timed out' };
    }

    const result = await pollDeviceAuth(init.deviceAuthId, init.userCode, endpoints, fetchImpl);
    if (result.status !== 'pending') return result;

    await sleep(intervalMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
