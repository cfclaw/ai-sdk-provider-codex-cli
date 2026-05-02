/**
 * Streaming variant of batch-tool-calls.mjs.
 *
 * Same setup, but using `streamText` and the `fullStream` so you can watch
 * the lifecycle of each tool call as it streams in:
 *   tool-input-start    — model started a function call
 *   tool-input-delta    — JSON arguments arriving incrementally
 *   tool-input-end      — argument JSON is complete
 *   tool-call           — finalized call dispatched to your `execute`
 *   tool-result         — `execute` returned
 *
 * When the model emits multiple function_calls in one turn you'll see
 * their lifecycles interleaved on the wire — that's batch parallelism.
 *
 * Run:  node examples/direct/batch-tool-calls-streaming.mjs
 */

import { streamText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { codexDirect } from 'ai-sdk-provider-codex-cli';

const tools = {
  getWeather: tool({
    description: 'Current weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => {
      await new Promise((r) => setTimeout(r, 250));
      return { city, temperatureC: 18, condition: 'partly cloudy' };
    },
  }),
  getLocalTime: tool({
    description: 'Current local time in a city.',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => {
      await new Promise((r) => setTimeout(r, 180));
      return { city, time: new Date().toISOString() };
    },
  }),
  getExchangeRate: tool({
    description: 'FX rate from one currency to another.',
    inputSchema: z.object({ from: z.string().length(3), to: z.string().length(3) }),
    execute: async ({ from, to }) => {
      await new Promise((r) => setTimeout(r, 300));
      return { from, to, rate: 0.93 };
    },
  }),
  getStockQuote: tool({
    description: 'Latest stock quote for a ticker.',
    inputSchema: z.object({ ticker: z.string() }),
    execute: async ({ ticker }) => {
      await new Promise((r) => setTimeout(r, 200));
      return { ticker, price: 213.45 };
    },
  }),
};

const result = streamText({
  model: codexDirect('gpt-5.3-codex'),
  tools,
  stopWhen: stepCountIs(4),
  prompt:
    'Briefing: weather in London + Tokyo, local times, USD→EUR rate, and the AAPL quote. ' +
    'Issue all tool calls you need in a single turn.',
});

// Track each call by its id so we can show argument-delta progress.
const pending = new Map();

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'tool-input-start':
      pending.set(part.id, { name: part.toolName, args: '' });
      console.log(`[${part.id}] start  ${part.toolName}(...)`);
      break;
    case 'tool-input-delta': {
      const p = pending.get(part.id);
      if (p) {
        p.args += part.delta;
        // Show how much JSON has arrived so far — useful when args are large.
        process.stdout.write(`[${part.id}] +${JSON.stringify(part.delta)}\n`);
      }
      break;
    }
    case 'tool-input-end': {
      const p = pending.get(part.id);
      console.log(`[${part.id}] end    ${p?.name ?? '?'}(${p?.args ?? ''})`);
      break;
    }
    case 'tool-call':
      console.log(`[${part.toolCallId}] DISPATCH ${part.toolName}`);
      break;
    case 'tool-result':
      console.log(
        `[${part.toolCallId}] RESULT   ${part.toolName} => ${JSON.stringify(part.output)}`,
      );
      pending.delete(part.toolCallId);
      break;
    case 'text-delta':
      process.stdout.write(part.text ?? part.delta ?? '');
      break;
    case 'finish':
      console.log(
        `\n\nfinish: ${part.finishReason} | tokens in=${part.totalUsage?.inputTokens?.total ?? '?'} out=${part.totalUsage?.outputTokens?.total ?? '?'}`,
      );
      break;
    case 'error':
      console.error('stream error:', part.error);
      break;
  }
}
