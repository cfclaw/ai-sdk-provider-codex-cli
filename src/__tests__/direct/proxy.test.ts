import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeProxyAwareFetch, resetProxyState } from '../../direct/proxy.js';

const PROXY_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];

const savedEnv: Record<string, string | undefined> = {};

function clearProxyEnv() {
  for (const key of PROXY_VARS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  for (const key of PROXY_VARS) savedEnv[key] = process.env[key];
  clearProxyEnv();
  resetProxyState();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of PROXY_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetProxyState();
});

describe('makeProxyAwareFetch', () => {
  it('passes the request straight through when no proxy env vars are set', async () => {
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const f = makeProxyAwareFetch();
    await f('https://example.test/');

    expect(upstream).toHaveBeenCalledTimes(1);
    const init = upstream.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(init?.dispatcher).toBeUndefined();
  });

  it('attaches an undici dispatcher when HTTPS_PROXY is set', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:5678';
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const f = makeProxyAwareFetch();
    await f('https://example.test/');

    expect(upstream).toHaveBeenCalledTimes(1);
    const init = upstream.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it('honors lowercase env var names too', async () => {
    process.env.http_proxy = 'http://127.0.0.1:5678';
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const f = makeProxyAwareFetch();
    await f('http://example.test/');

    const init = upstream.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it('reuses the cached dispatcher across calls until env vars change', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:5678';
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const f = makeProxyAwareFetch();
    await f('https://a.test/');
    await f('https://b.test/');

    const init1 = upstream.mock.calls[0]?.[1] as { dispatcher?: unknown };
    const init2 = upstream.mock.calls[1]?.[1] as { dispatcher?: unknown };
    expect(init1.dispatcher).toBe(init2.dispatcher);

    // Change env -> new dispatcher
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9999';
    await f('https://c.test/');
    const init3 = upstream.mock.calls[2]?.[1] as { dispatcher?: unknown };
    expect(init3.dispatcher).not.toBe(init1.dispatcher);
  });

  it('warns once and falls through when only a SOCKS proxy is configured', async () => {
    process.env.ALL_PROXY = 'socks5://127.0.0.1:5678';
    const warn = vi.fn();
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const f = makeProxyAwareFetch({ warn });
    await f('https://example.test/');
    await f('https://example.test/');

    // Warning fires only once even on repeated calls.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/SOCKS proxy/i);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('reflects env var changes between calls (no construction-time snapshot)', async () => {
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const f = makeProxyAwareFetch();
    await f('https://example.test/');
    let init = upstream.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeUndefined();

    // Set proxy after the fetch was created.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:5678';
    await f('https://example.test/');
    init = upstream.mock.calls[1]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeDefined();
  });
});
