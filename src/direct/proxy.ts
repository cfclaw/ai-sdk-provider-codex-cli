/**
 * Proxy support for `codexDirect`.
 *
 * Honors the standard Unix proxy environment variables on every request:
 *
 *   HTTP_PROXY  / http_proxy   — proxy URL for HTTP destinations
 *   HTTPS_PROXY / https_proxy  — proxy URL for HTTPS destinations
 *   NO_PROXY    / no_proxy     — comma-separated bypass list
 *   ALL_PROXY   / all_proxy    — fallback for both schemes
 *
 * Implementation uses undici's `EnvHttpProxyAgent`, which reads these
 * variables (and re-reads them) every time it dispatches. We construct it
 * lazily on the first request that has proxy env vars set, and rebuild it
 * if the env changes between requests.
 *
 * SOCKS proxies (e.g. `ALL_PROXY=socks5://127.0.0.1:1080`) are NOT covered
 * by the bundled undici dispatcher. If we detect a SOCKS scheme we log a
 * one-time warning explaining how to wire up SOCKS via a custom fetch.
 */

import { createRequire } from 'node:module';
import type { Logger } from '../types-shared.js';

const require = createRequire(import.meta.url);

interface UndiciDispatcher {
  destroy?: () => Promise<void>;
}
type EnvHttpProxyAgentCtor = new () => UndiciDispatcher;

interface UndiciExports {
  EnvHttpProxyAgent?: EnvHttpProxyAgentCtor;
}

let cachedDispatcher: { dispatcher: UndiciDispatcher; envKey: string } | undefined;
let socksWarned = false;
let undiciMissingWarned = false;

function envValue(name: string): string {
  return process.env[name] ?? process.env[name.toLowerCase()] ?? '';
}

function envKey(): string {
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
    .map((name) => `${name}=${envValue(name)}`)
    .join('|');
}

function hasProxyEnv(): boolean {
  return !!(envValue('HTTP_PROXY') || envValue('HTTPS_PROXY') || envValue('ALL_PROXY'));
}

function isSocksProxy(): boolean {
  return /^socks/i.test(envValue('ALL_PROXY'));
}

function loadEnvHttpProxyAgent(): EnvHttpProxyAgentCtor | null {
  try {
    const mod = require('undici') as UndiciExports;
    return mod.EnvHttpProxyAgent ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns a fetch implementation that honors proxy env vars set in the
 * process environment. If no proxy env vars are set at request time, the
 * returned function delegates straight to `globalThis.fetch`.
 *
 * Pass a logger to receive diagnostic warnings (missing undici, SOCKS
 * detected, etc.). In tests you can also inject a fully-custom fetch via
 * `createCodexDirect({ fetch })` and bypass this helper entirely.
 */
export function makeProxyAwareFetch(logger?: Pick<Logger, 'warn'>): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!hasProxyEnv()) {
      return globalThis.fetch(input, init);
    }

    if (isSocksProxy() && !socksWarned) {
      socksWarned = true;
      logger?.warn(
        'codex-direct: SOCKS proxy detected via ALL_PROXY but undici has no built-in SOCKS dispatcher. ' +
          'Install `socks-proxy-agent` and pass a custom `fetch` to createCodexDirect({ fetch }) to use it. ' +
          'HTTP_PROXY/HTTPS_PROXY (if set) will still be honored.',
      );
    }

    const Ctor = loadEnvHttpProxyAgent();
    if (!Ctor) {
      if (!undiciMissingWarned) {
        undiciMissingWarned = true;
        logger?.warn(
          'codex-direct: proxy env vars are set but the `undici` package is unavailable. ' +
            'Proxies will be ignored. Install undici to enable HTTP/HTTPS proxy support.',
        );
      }
      return globalThis.fetch(input, init);
    }

    const key = envKey();
    if (!cachedDispatcher || cachedDispatcher.envKey !== key) {
      cachedDispatcher = { dispatcher: new Ctor(), envKey: key };
    }

    // Node's native `fetch` accepts undici's `dispatcher` option even though
    // it isn't part of the standard `RequestInit` typings.
    return globalThis.fetch(input, {
      ...(init ?? {}),
      dispatcher: cachedDispatcher.dispatcher,
    } as Parameters<typeof fetch>[1] & { dispatcher: unknown });
  }) as typeof fetch;
}

/**
 * Test-only helper to clear the cached dispatcher and one-time-warning flags.
 * Exported so unit tests can simulate fresh process state.
 */
export function resetProxyState(): void {
  cachedDispatcher = undefined;
  socksWarned = false;
  undiciMissingWarned = false;
}
