/**
 * Browser PKCE login: opens auth.openai.com in your default browser, listens
 * on http://127.0.0.1:1455 for the redirect, and writes the tokens to
 * ~/.codex/auth.json on success.
 *
 * Use this on a desktop where the same machine can run a browser. For
 * headless / SSH / remote, use `login-device.mjs` instead.
 *
 * Run:  node examples/direct/login-browser.mjs
 */

import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { startCodexOAuthFlow, saveCodexAuth, defaultAuthFilePath } from 'ai-sdk-provider-codex-cli';

function openBrowser(url) {
  const cmd =
    platform() === 'darwin'
      ? `open "${url}"`
      : platform() === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best-effort — caller can also click the URL themselves */
  });
}

async function main() {
  const flow = await startCodexOAuthFlow({ timeoutMs: 5 * 60 * 1000 });

  console.log('\n=== Codex browser login ===');
  console.log('Opening:', flow.authUrl);
  console.log('(If it does not open automatically, paste that URL into your browser.)');
  openBrowser(flow.authUrl);

  const result = await flow.waitForCompletion();
  if (!result.success || !result.state) {
    console.error(`\nLogin failed: ${result.error ?? 'unknown error'}`);
    process.exit(1);
  }

  await saveCodexAuth(result.state);

  const expiresInMin = Math.round((result.state.expires - Date.now()) / 60_000);
  console.log(`\nLogged in. Tokens written to ${defaultAuthFilePath()}`);
  console.log(`  account: ${result.state.accountId ?? '(unknown)'}`);
  console.log(`  expires in: ~${expiresInMin} min (auto-refreshed afterward)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
