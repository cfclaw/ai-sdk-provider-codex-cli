/**
 * Batch (parallel) tool calls with codexDirect.
 *
 * The Codex Responses API will emit multiple `function_call` items in a
 * single assistant turn when the prompt warrants it. The AI SDK runs all
 * `tool.execute()` functions for that turn in parallel, then sends the
 * batch of results back to the model in one follow-up request — so you
 * get N tools per round-trip instead of N round-trips.
 *
 * This example defines four tools (weather, time, currency rate, stock
 * quote) and asks one question that needs several at once. Watch the
 * step log: in step 1 you'll see multiple `tool-call`s, all run
 * concurrently, then a step 2 where the model writes its summary.
 *
 * Prereq:  ~/.codex/auth.json must exist. Run one of:
 *            node examples/direct/login-device.mjs
 *            node examples/direct/login-browser.mjs
 *
 * Run:     node examples/direct/batch-tool-calls.mjs
 */

import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { codexDirect } from 'ai-sdk-provider-codex-direct';

// Track concurrency so we can prove the calls really did run in parallel.
let inFlight = 0;
let maxInFlight = 0;
const callLog = [];

function track(name) {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  const start = Date.now();
  callLog.push({ name, start });
  return () => {
    inFlight -= 1;
    const last = callLog[callLog.length - 1];
    last.durationMs = Date.now() - start;
  };
}

// Stand-in implementations — replace these with real APIs in your app.
const tools = {
  getWeather: tool({
    description: 'Get the current weather for a city.',
    inputSchema: z.object({
      city: z.string().describe('City name, e.g. "London"'),
    }),
    execute: async ({ city }) => {
      const done = track(`getWeather(${city})`);
      await new Promise((r) => setTimeout(r, 250)); // simulate network
      done();
      return { city, temperatureC: 18, condition: 'partly cloudy' };
    },
  }),

  getLocalTime: tool({
    description: 'Get the current local time in a city.',
    inputSchema: z.object({
      city: z.string(),
    }),
    execute: async ({ city }) => {
      const done = track(`getLocalTime(${city})`);
      await new Promise((r) => setTimeout(r, 200));
      done();
      return { city, time: new Date().toISOString() };
    },
  }),

  getExchangeRate: tool({
    description: 'Get the FX rate from one currency to another.',
    inputSchema: z.object({
      from: z.string().length(3).describe('ISO-4217 code, e.g. USD'),
      to: z.string().length(3),
    }),
    execute: async ({ from, to }) => {
      const done = track(`getExchangeRate(${from}->${to})`);
      await new Promise((r) => setTimeout(r, 300));
      done();
      const rates = { 'USD->EUR': 0.93, 'USD->GBP': 0.79, 'USD->JPY': 156.4 };
      return { from, to, rate: rates[`${from}->${to}`] ?? 1 };
    },
  }),

  getStockQuote: tool({
    description: 'Get the latest stock quote for a ticker.',
    inputSchema: z.object({
      ticker: z.string().describe('Ticker symbol, e.g. AAPL'),
    }),
    execute: async ({ ticker }) => {
      const done = track(`getStockQuote(${ticker})`);
      await new Promise((r) => setTimeout(r, 220));
      done();
      const quotes = { AAPL: 213.45, MSFT: 421.0, GOOG: 178.2 };
      return { ticker, price: quotes[ticker] ?? 100 };
    },
  }),
};

const result = await generateText({
  model: codexDirect('gpt-5.5'),
  tools,
  // Allow up to 4 model<->tools round trips. Without `stopWhen`, the
  // SDK would return after the very first tool batch without ever
  // letting the model summarize.
  stopWhen: stepCountIs(4),
  prompt:
    "I'm a US-based trader doing a morning briefing. Tell me, in one paragraph: " +
    'the current weather in London and Tokyo, the local time in both, the USD→EUR ' +
    'and USD→JPY rates, and the latest quotes for AAPL and MSFT. ' +
    'Issue all the tool calls you need for this in a single turn.',
  onStepFinish: ({ toolCalls, toolResults, finishReason }) => {
    if (toolCalls.length > 0) {
      console.log(`\n--- step finished (${toolCalls.length} tool call(s)) ---`);
      for (const call of toolCalls) {
        console.log(`  -> ${call.toolName}(${JSON.stringify(call.input)})`);
      }
      for (const res of toolResults) {
        console.log(`  <- ${res.toolName}: ${JSON.stringify(res.output)}`);
      }
    } else {
      console.log(`\n--- step finished (no tool calls, finish=${finishReason}) ---`);
    }
  },
});

console.log('\n========== Final answer ==========');
console.log(result.text);
console.log('\n========== Run summary ==========');
console.log(`steps:               ${result.steps.length}`);
console.log(`total tool calls:    ${callLog.length}`);
console.log(`peak concurrency:    ${maxInFlight} tools running in parallel`);
console.log(`finish reason:       ${result.finishReason}`);
console.log(
  `tokens (in/out):     ${result.usage.inputTokens?.total ?? '?'} / ${result.usage.outputTokens?.total ?? '?'}`,
);
