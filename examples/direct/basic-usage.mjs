/**
 * End-to-end smoke test: send one prompt through codexDirect using whatever
 * tokens are in ~/.codex/auth.json. If the access token is expired the
 * provider refreshes it transparently before sending.
 *
 * Run:  node examples/direct/basic-usage.mjs
 *
 * Run a login script first if you don't have ~/.codex/auth.json yet.
 */

import { generateText } from 'ai';
import { codexDirect } from 'ai-sdk-provider-codex-direct';

const { text, usage } = await generateText({
  model: codexDirect('gpt-5.5'),
  prompt: 'Reply with exactly one word: hello.',
});

console.log('Response:', text);
console.log('Usage:', usage);
