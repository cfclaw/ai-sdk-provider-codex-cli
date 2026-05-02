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
    expect(headers.originator).toBe('ai-sdk-provider-codex-direct');

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

  it('always sends include:[reasoning.encrypted_content] in the request body', async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body));
      return sseStream([
        { type: 'response.completed', response: { status: 'completed', usage: {} } },
        '[DONE]',
      ]);
    };
    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });
    await model.doGenerate({ prompt: basicPrompt('hi') } as LanguageModelV3CallOptions);
    expect(captured?.include).toEqual(['reasoning.encrypted_content']);
  });

  it('refreshes the access token and retries once on 401', async () => {
    let call = 0;
    const tokensSeen: string[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/oauth/token')) {
        // Refresh response — issue a brand new access token.
        const renewed = makeJwt({ chatgpt_account_id: 'acc-renewed' });
        return new Response(
          JSON.stringify({ access_token: renewed, refresh_token: 'r2', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // /codex/responses
      call++;
      const headers = (init as RequestInit).headers as Record<string, string>;
      tokensSeen.push(headers.Authorization ?? '');
      if (call === 1) return new Response('revoked', { status: 401 });
      return sseStream([
        { type: 'response.completed', response: { status: 'completed', usage: {} } },
        '[DONE]',
      ]);
    };

    // Auth manager wired to the same fakeFetch so the 401 retry path's
    // forceRefresh hits the stubbed /oauth/token endpoint, not the real one.
    const manager = new CodexAuthManager({
      source: {
        state: {
          accessToken: makeJwt({ chatgpt_account_id: 'acc-stale' }),
          refreshToken: 'r1',
          accountId: 'acc-stale',
          expires: Date.now() + 60 * 60_000,
        },
      },
      persist: false,
      endpoints: ENDPOINTS,
      fetch: fakeFetch,
    });

    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: manager,
      fetch: fakeFetch,
    });

    const result = await model.doGenerate({
      prompt: basicPrompt('hi'),
    } as LanguageModelV3CallOptions);

    // Two POSTs to /codex/responses (initial + retry) with different tokens.
    expect(call).toBe(2);
    expect(tokensSeen[0]).not.toBe(tokensSeen[1]);
    expect(result.finishReason.unified).toBe('stop');
  });

  it('uses the server response id in response-metadata and bubbles it on finish', async () => {
    const fakeFetch: typeof fetch = async () =>
      sseStream([
        { type: 'response.created', response: { id: 'resp_abc123', model: 'gpt-5.3-codex' } },
        { type: 'response.output_text.delta', delta: 'hi' },
        {
          type: 'response.completed',
          response: { id: 'resp_abc123', status: 'completed', usage: {} },
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
    } as LanguageModelV3CallOptions);

    const parts: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const meta = parts.find((p) => p.type === 'response-metadata');
    expect(meta).toBeDefined();
    expect((meta as { id: string }).id).toBe('resp_abc123');

    const finish = parts.find((p) => p.type === 'finish');
    expect(
      (finish as { providerMetadata?: { 'codex-direct'?: { responseId?: string } } })
        .providerMetadata?.['codex-direct']?.responseId,
    ).toBe('resp_abc123');
  });

  it('maps input_tokens_details.cached_tokens to usage.inputTokens.cacheRead', async () => {
    const fakeFetch: typeof fetch = async () =>
      sseStream([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              input_tokens_details: { cached_tokens: 800 },
            },
          },
        },
        '[DONE]',
      ]);

    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });
    const result = await model.doGenerate({
      prompt: basicPrompt('hi'),
    } as LanguageModelV3CallOptions);

    expect(result.usage.inputTokens.total).toBe(1000);
    expect(result.usage.inputTokens.cacheRead).toBe(800);
    expect(result.usage.inputTokens.noCache).toBe(200);
  });

  it('captures encrypted reasoning content and surfaces it via providerMetadata', async () => {
    const fakeFetch: typeof fetch = async () =>
      sseStream([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_42', summary: [] },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_42',
          delta: 'thinking...',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_42',
            summary: [{ type: 'summary_text', text: 'thinking...' }],
            encrypted_content: 'OPAQUE_BLOB',
          },
        },
        {
          type: 'response.completed',
          response: { status: 'completed', usage: {} },
        },
        '[DONE]',
      ]);

    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });

    const result = await model.doGenerate({
      prompt: basicPrompt('hi'),
    } as LanguageModelV3CallOptions);

    const reasoning = result.content.find((c) => c.type === 'reasoning');
    expect(reasoning).toBeDefined();
    expect((reasoning as { text: string }).text).toBe('thinking...');
    expect(
      (reasoning as { providerMetadata?: { 'codex-direct'?: Record<string, unknown> } })
        .providerMetadata?.['codex-direct'],
    ).toMatchObject({ itemId: 'rs_42', encryptedContent: 'OPAQUE_BLOB' });
  });

  it('forwards previous_response_id and forces store:true', async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body));
      return sseStream([
        { type: 'response.completed', response: { status: 'completed', usage: {} } },
        '[DONE]',
      ]);
    };
    const model = new CodexDirectLanguageModel({
      modelId: 'gpt-5.3-codex',
      authManager: makeManager(),
      fetch: fakeFetch,
    });

    await model.doGenerate({
      prompt: basicPrompt('continue'),
      providerOptions: {
        'codex-direct': { previousResponseId: 'resp_prev' },
      },
    } as LanguageModelV3CallOptions);

    expect(captured?.previous_response_id).toBe('resp_prev');
    expect(captured?.store).toBe(true);
  });
});
