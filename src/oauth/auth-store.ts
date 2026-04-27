import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodexOAuthState } from './types.js';
import { extractAccountId } from './jwt.js';

/**
 * Default location of the auth file written by `codex login`. Matches the
 * Codex CLI's own storage so users authenticated via the CLI work without
 * any extra steps.
 */
export function defaultAuthFilePath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

/**
 * Shape of the `~/.codex/auth.json` file written by the official Codex CLI.
 * Only the fields we care about are typed; we tolerate extras.
 */
interface CodexAuthFile {
  OPENAI_API_KEY?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/**
 * Try to read OAuth tokens from `~/.codex/auth.json` (or a custom path).
 * Returns null if the file doesn't exist or doesn't contain OAuth tokens
 * (e.g. it only has `OPENAI_API_KEY`).
 */
export async function loadCodexAuth(
  filePath: string = defaultAuthFilePath(),
): Promise<CodexOAuthState | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(raw) as CodexAuthFile;
  } catch {
    return null;
  }

  const tokens = parsed.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) return null;

  // The CLI persists `last_refresh` rather than a hard expiry. The OpenAI
  // access tokens are 28-day JWTs, but we conservatively treat anything
  // older than 7 days as needing a refresh. The provider will refresh
  // automatically on the next request if it's actually expired.
  const lastRefresh = parsed.last_refresh ? Date.parse(parsed.last_refresh) : NaN;
  const expires = Number.isFinite(lastRefresh) ? lastRefresh + 7 * 24 * 60 * 60 * 1000 : Date.now();

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expires,
    accountId: tokens.account_id ?? extractAccountId(tokens.access_token, tokens.id_token),
  };
}

/**
 * Persist OAuth tokens back to `~/.codex/auth.json` using the same schema
 * the Codex CLI writes. Preserves any `OPENAI_API_KEY` / `id_token` already
 * on disk so we don't clobber unrelated fields.
 *
 * The file is written with `0600` permissions because it contains long-lived
 * credentials. On Windows `chmod` is a no-op, which is fine.
 */
export async function saveCodexAuth(
  state: CodexOAuthState,
  filePath: string = defaultAuthFilePath(),
): Promise<void> {
  let existing: CodexAuthFile = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    existing = JSON.parse(raw) as CodexAuthFile;
  } catch {
    // First-time write or malformed file — start fresh.
  }

  const next: CodexAuthFile = {
    ...existing,
    tokens: {
      ...(existing.tokens ?? {}),
      access_token: state.accessToken,
      refresh_token: state.refreshToken,
      account_id: state.accountId ?? existing.tokens?.account_id,
    },
    last_refresh: new Date().toISOString(),
  };

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8');
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best effort — Windows / restricted filesystems may not support chmod.
  }
}
