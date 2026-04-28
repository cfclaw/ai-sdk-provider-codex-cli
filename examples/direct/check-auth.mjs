/**
 * Read ~/.codex/auth.json and print whether the tokens look usable. Useful
 * smoke test after running login-device.mjs or login-browser.mjs.
 *
 * Run:  node examples/direct/check-auth.mjs
 */

import { loadCodexAuth, defaultAuthFilePath } from 'ai-sdk-provider-codex-cli';

const path = defaultAuthFilePath();
const state = await loadCodexAuth();

if (!state) {
  console.error(`No usable OAuth tokens found at ${path}.`);
  console.error('Run: node examples/direct/login-device.mjs');
  process.exit(1);
}

const minutes = Math.round((state.expires - Date.now()) / 60_000);
console.log(`auth.json: ${path}`);
console.log(`  account:  ${state.accountId ?? '(unknown)'}`);
console.log(`  expires:  in ~${minutes} min (refresh-token rotates this automatically)`);
console.log(`  access:   ${state.accessToken.slice(0, 12)}…`);
console.log(`  refresh:  ${state.refreshToken.slice(0, 12)}…`);
