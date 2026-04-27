import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCodexAuth, saveCodexAuth } from '../../oauth/auth-store.js';

let tmpDir = '';
let authPath = '';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  mkdirSync(join(tmpDir, '.codex'), { recursive: true });
  authPath = join(tmpDir, '.codex', 'auth.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadCodexAuth', () => {
  it('returns null when the file does not exist', async () => {
    expect(await loadCodexAuth(join(tmpDir, 'missing.json'))).toBeNull();
  });

  it('returns null for an OPENAI_API_KEY-only file (no OAuth tokens)', async () => {
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-abc' }));
    expect(await loadCodexAuth(authPath)).toBeNull();
  });

  it('parses tokens and extracts the accountId from the JWT', async () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'acc-jwt' });
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: 'refresh-1',
        },
      }),
    );

    const state = await loadCodexAuth(authPath);
    expect(state).not.toBeNull();
    expect(state?.accessToken).toBe(accessToken);
    expect(state?.refreshToken).toBe('refresh-1');
    expect(state?.accountId).toBe('acc-jwt');
  });

  it('prefers the explicit account_id field over JWT extraction', async () => {
    const accessToken = makeJwt({ chatgpt_account_id: 'acc-jwt' });
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: 'refresh-1',
          account_id: 'acc-explicit',
        },
      }),
    );
    const state = await loadCodexAuth(authPath);
    expect(state?.accountId).toBe('acc-explicit');
  });

  it('returns null for malformed JSON', async () => {
    writeFileSync(authPath, '{not json');
    expect(await loadCodexAuth(authPath)).toBeNull();
  });
});

describe('saveCodexAuth', () => {
  it('writes tokens and last_refresh, preserving unrelated fields', async () => {
    writeFileSync(
      authPath,
      JSON.stringify({ OPENAI_API_KEY: 'sk-keep', tokens: { id_token: 'id-keep' } }),
    );

    await saveCodexAuth(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accountId: 'acc-1',
        expires: Date.now() + 3600_000,
      },
      authPath,
    );

    const written = JSON.parse(readFileSync(authPath, 'utf-8'));
    expect(written.OPENAI_API_KEY).toBe('sk-keep');
    expect(written.tokens.id_token).toBe('id-keep');
    expect(written.tokens.access_token).toBe('new-access');
    expect(written.tokens.refresh_token).toBe('new-refresh');
    expect(written.tokens.account_id).toBe('acc-1');
    expect(typeof written.last_refresh).toBe('string');
  });

  it('creates the parent directory when missing', async () => {
    const nested = join(tmpDir, 'nested', 'sub', 'auth.json');
    await saveCodexAuth(
      { accessToken: 'a', refreshToken: 'r', expires: Date.now() + 1000 },
      nested,
    );
    const written = JSON.parse(readFileSync(nested, 'utf-8'));
    expect(written.tokens.access_token).toBe('a');
  });
});
