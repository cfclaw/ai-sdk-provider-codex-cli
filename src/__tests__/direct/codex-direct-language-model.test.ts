import { describe, expect, it } from 'vitest';
import { CodexAuthManager } from '../../direct/auth-manager.js';
import { CodexDirectLanguageModel } from '../../direct/codex-direct-language-model.js';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';

const ENDPOINTS = { issuer: 'https://auth.example.test', clientId: 'client-xyz' };

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function sseStream(events: Array<Record<string, unknown> | '[DONE]'>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        const payload = e === '[DONE]' ? '[DONE]' : JSON.stringify(e);
        controller.enqueue(enc.encode(`data: ${payload}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeManager() {
  return new CodexAuthManager({
    source: {
      state: {
        accessToken: makeJwt({ chatgpt_account_id: 'acc-1' }),
        refreshToken: 'r',
        accountId: 'acc-1',
        expires: Date.now() + 60 * 60_000,
      },
    },
    persist: false,
    endpoints: ENDPOINTS,
  });
}

function basicPrompt(text: string): LanguageModelV3CallOptions['prompt'] {
  return [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: [{ type: 'text', text }] },
  ];
}

describe('CodexDirectLanguageModel', () => {
  it('maps text deltas and a completed response into AI SDK stream parts', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      captured.url = String(url);
      captured.init = init as RequestInit;
      return sseStream([
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ', world' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              output_tokens_details: { reasoning_tokens: 1 },
            },
          },
        },
        '[DONE]',
      ]);
    };

    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });

    const result = await model.doGenerate({
      prompt: basicPrompt('hi'),
    } as LanguageModelV3CallOptions);

    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Hello, world' }),
    ]);
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'completed' });
    expect(result.usage.inputTokens.total).toBe(10);
    expect(result.usage.outputTokens.total).toBe(4);
    expect(result.usage.outputTokens.reasoning).toBe(1);

    // Verify request shape: target URL, headers, and body.
    expect(captured.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers['ChatGPT-Account-Id']).toBe('acc-1');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(headers.originator).toBe('ai-sdk-provider-codex-cli');

    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe('gpt-5.3-codex');
    expect(body.instructions).toBe('Be terse.');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('emits tool-call stream parts with translated call_ ids', async () => {
    const fakeFetch: typeof fetch = async () =>
      sseStream([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_abc',
            call_id: 'fc_abc',
            name: 'search',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"q":',
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '"hi"}',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_abc',
            call_id: 'fc_abc',
            name: 'search',
            arguments: '{"q":"hi"}',
          },
        },
        {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        },
        '[DONE]',
      ]);

    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });

    const { stream } = await model.doStream({
      prompt: basicPrompt('hi'),
      tools: [
        {
          type: 'function',
          name: 'search',
          description: 'search',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    } as LanguageModelV3CallOptions);

    const parts: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const types = parts.map((p) => p.type);
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-input-end');
    expect(types).toContain('tool-call');

    const toolCall = parts.find((p) => p.type === 'tool-call');
    expect(toolCall).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call_abc', // translated back from fc_
      toolName: 'search',
      input: '{"q":"hi"}',
    });
  });

  it('throws an APICallError with the response body on a non-2xx response', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('upstream rate limited', {
        status: 429,
        headers: { 'content-type': 'text/plain' },
      });

    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });

    await expect(
      model.doGenerate({ prompt: basicPrompt('hi') } as LanguageModelV3CallOptions),
    ).rejects.toThrow(/429/);
  });

  it('emits warnings for unsupported sampling options', async () => {
    const fakeFetch: typeof fetch = async () =>
      sseStream([
        { type: 'response.completed', response: { status: 'completed', usage: {} } },
        '[DONE]',
      ]);

    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });

    const result = await model.doGenerate({
      prompt: basicPrompt('hi'),
      temperature: 0.7,
      topP: 0.9,
      seed: 42,
    } as LanguageModelV3CallOptions);

    const features = result.warnings.map((w) => (w.type === 'unsupported' ? w.feature : 'other'));
    expect(features).toEqual(expect.arrayContaining(['temperature', 'topP', 'seed']));
  });
});
