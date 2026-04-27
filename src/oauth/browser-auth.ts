/**
 * Browser-based PKCE OAuth flow for Codex.
 *
 * 1. Generate a PKCE challenge/verifier pair + a random `state`.
 * 2. Build the authorization URL pointing at auth.openai.com/oauth/authorize.
 * 3. Start a local HTTP server on 127.0.0.1:1455 to receive the redirect.
 * 4. Caller opens the URL in the user's browser (or returns it to a frontend).
 * 5. Local server captures the `code`, validates `state`, exchanges it for
 *    access + refresh tokens via /oauth/token.
 *
 * Use this in interactive desktop apps. For headless / IPC scenarios use the
 * device-code flow in `device-auth.ts` instead.
 */

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { CodexOAuthEndpoints, CodexOAuthState } from './types.js';
import { DEFAULT_OAUTH_ENDPOINTS } from './types.js';
import { extractAccountId } from './jwt.js';

const SCOPE = 'openid profile email offline_access';
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_CALLBACK_PATH = '/auth/callback';

interface PKCEPair {
  challenge: string;
  verifier: string;
}

export interface CodexOAuthResult {
  success: boolean;
  state?: CodexOAuthState;
  error?: string;
}

export interface BrowserAuthOptions {
  /** Override the issuer / client_id (mainly for testing). */
  endpoints?: CodexOAuthEndpoints;
  /** Local callback port. Defaults to 1455 (matches the Codex CLI). */
  callbackPort?: number;
  /** How long to wait for the user to complete the flow (ms). Default 2min. */
  timeoutMs?: number;
}

function generatePKCE(): PKCEPair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { challenge, verifier };
}

function createState(): string {
  return randomBytes(16).toString('hex');
}

function buildAuthorizationUrl(
  pkce: PKCEPair,
  state: string,
  endpoints: CodexOAuthEndpoints,
  redirectUri: string,
): string {
  const url = new URL(`${endpoints.issuer}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', endpoints.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // These flags match the Codex CLI's authorization request and ensure the
  // returned tokens include the ChatGPT account claims we need.
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');
  return url.toString();
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  endpoints: CodexOAuthEndpoints,
  redirectUri: string,
): Promise<CodexOAuthState | null> {
  const response = await fetch(`${endpoints.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: endpoints.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!response.ok) return null;

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!json.access_token || !json.refresh_token) return null;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(json.access_token, json.id_token),
  };
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0; }
    .container { text-align: center; max-width: 400px; padding: 1rem; }
    h1 { color: #4ade80; font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #888; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication successful</h1>
    <p>Your ChatGPT subscription has been connected.</p>
    <p>You can close this window and return to the application.</p>
  </div>
</body>
</html>`;

function startCallbackServer(
  expectedState: string,
  callbackPath: string,
  callbackPort: number,
  timeoutMs: number,
): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: { code: string } | { error: string }) => {
      if (resolved) return;
      resolved = true;
      server.close();
      resolve(value);
    };

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        if (url.pathname !== callbackPath) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        if (url.searchParams.get('state') !== expectedState) {
          res.statusCode = 400;
          res.end('State mismatch');
          finish({ error: 'OAuth state mismatch' });
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          res.statusCode = 400;
          res.end(`Authorization failed: ${error}`);
          finish({ error: `Authorization denied: ${error}` });
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          res.statusCode = 400;
          res.end('Missing authorization code');
          finish({ error: 'Authorization callback missing code' });
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(SUCCESS_HTML);
        finish({ code });
      } catch {
        res.statusCode = 500;
        res.end('Internal error');
      }
    });

    const timer = setTimeout(() => {
      finish({ error: 'OAuth flow timed out' });
    }, timeoutMs);

    server.on('close', () => clearTimeout(timer));

    server.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        error: `Failed to bind callback server on port ${callbackPort}: ${err.code ?? err.message}`,
      });
    });

    server.listen(callbackPort, '127.0.0.1');
  });
}

/**
 * Start the browser PKCE flow. Returns the URL the user should open and a
 * promise that resolves with the final tokens (or an error) once the user
 * completes — or fails — the flow.
 *
 * The caller is responsible for opening `authUrl` in the user's browser.
 * In a headless context (no browser binding), prefer `initiateDeviceAuth`.
 */
export async function startCodexOAuthFlow(options: BrowserAuthOptions = {}): Promise<{
  authUrl: string;
  waitForCompletion: () => Promise<CodexOAuthResult>;
}> {
  const endpoints = options.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
  const callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${callbackPort}${DEFAULT_CALLBACK_PATH}`;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const pkce = generatePKCE();
  const state = createState();
  const authUrl = buildAuthorizationUrl(pkce, state, endpoints, redirectUri);

  const callbackPromise = startCallbackServer(
    state,
    DEFAULT_CALLBACK_PATH,
    callbackPort,
    timeoutMs,
  );

  const waitForCompletion = async (): Promise<CodexOAuthResult> => {
    const callback = await callbackPromise;

    if ('error' in callback) {
      return { success: false, error: callback.error };
    }

    const tokens = await exchangeAuthorizationCode(
      callback.code,
      pkce.verifier,
      endpoints,
      redirectUri,
    );

    if (!tokens) {
      return { success: false, error: 'Failed to exchange authorization code for tokens' };
    }

    return { success: true, state: tokens };
  };

  return { authUrl, waitForCompletion };
}

/**
 * Manual fallback for environments where the local callback server can't
 * bind (e.g. ports blocked, sandboxed). The user pastes the authorization
 * code from the browser back into the app, and we exchange it here using
 * the verifier the caller stashed when it generated the URL.
 */
export async function exchangeCodeManually(
  code: string,
  verifier: string,
  options: BrowserAuthOptions = {},
): Promise<CodexOAuthResult> {
  const endpoints = options.endpoints ?? DEFAULT_OAUTH_ENDPOINTS;
  const callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${callbackPort}${DEFAULT_CALLBACK_PATH}`;
  const tokens = await exchangeAuthorizationCode(code, verifier, endpoints, redirectUri);
  if (!tokens) {
    return { success: false, error: 'Failed to exchange authorization code' };
  }
  return { success: true, state: tokens };
}
