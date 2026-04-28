/**
 * Device-code login: works on headless servers, in CI, over SSH — anywhere
 * the local machine can't open a browser back to itself. You see a code, go
 * to the URL on any device with a browser, paste it in, done.
 *
 * Run:  node examples/direct/login-device.mjs
 *
 * On success the tokens are written to ~/.codex/auth.json (the same file
 * the official `codex login` writes), so subsequent runs of any tool that
 * uses this provider — including `codexDirect` — pick them up automatically.
 */

import {
  initiateDeviceAuth,
  pollDeviceAuthUntilComplete,
  saveCodexAuth,
  defaultAuthFilePath,
} from 'ai-sdk-provider-codex-cli';

async function main() {
  const init = await initiateDeviceAuth();

  console.log('\n=== Codex device-code login ===');
  console.log(`1. Open this URL in any browser:\n     ${init.verificationUrl}`);
  console.log(`2. Enter this code:\n     ${init.userCode}`);
  console.log(`3. Approve the request.\n`);
  console.log(`Polling every ${init.interval}s...`);

  const result = await pollDeviceAuthUntilComplete(init);

  if (result.status !== 'success') {
    console.error(`\nLogin failed: ${result.status === 'failed' ? result.error : 'unknown'}`);
    process.exit(1);
  }

  await saveCodexAuth(result.tokens);

  const expiresInMin = Math.round((result.tokens.expires - Date.now()) / 60_000);
  console.log(`\nLogged in. Tokens written to ${defaultAuthFilePath()}`);
  console.log(`  account: ${result.tokens.accountId ?? '(unknown)'}`);
  console.log(`  expires in: ~${expiresInMin} min (auto-refreshed afterward)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
