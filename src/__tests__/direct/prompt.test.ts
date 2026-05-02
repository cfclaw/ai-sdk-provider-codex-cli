import { describe, expect, it } from 'vitest';
import {
  convertPromptToCodexInput,
  convertTools,
  fromCodexId,
  sanitizeStrictSchema,
  toCodexId,
} from '../../direct/prompt.js';
import type { LanguageModelV3Prompt, SharedV3Warning } from '@ai-sdk/provider';

describe('toCodexId / fromCodexId', () => {
  it('round-trips between call_ and fc_ prefixes', () => {
    expect(toCodexId('call_abc')).toBe('fc_abc');
    expect(fromCodexId('fc_abc')).toBe('call_abc');
    // Pass-through for already-prefixed or unprefixed ids.
    expect(toCodexId('fc_abc')).toBe('fc_abc');
    expect(fromCodexId('call_abc')).toBe('call_abc');
    expect(toCodexId('something-else')).toBe('something-else');
  });
});

describe('convertPromptToCodexInput', () => {
  it('collapses system messages into a single instructions string', () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'Be helpful.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const result = convertPromptToCodexInput(prompt);
    expect(result.instructions).toBe('Be helpful.\n\nBe concise.');
    expect(result.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('emits assistant tool calls as top-level function_call items with fc_ ids', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling tool' },
          {
            type: 'tool-call',
            toolCallId: 'call_abc',
            toolName: 'search',
            input: { q: 'hello' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_abc',
            toolName: 'search',
            output: { type: 'text', value: 'found it' },
          },
        ],
      },
    ];
    const result = convertPromptToCodexInput(prompt);

    expect(result.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'calling tool' }],
      },
      {
        type: 'function_call',
        id: 'fc_abc',
        call_id: 'fc_abc',
        name: 'search',
        arguments: JSON.stringify({ q: 'hello' }),
      },
      {
        type: 'function_call_output',
        call_id: 'fc_abc',
        output: 'found it',
      },
    ]);
  });

  it('forwards image file parts as input_image content', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'file',
            mediaType: 'image/png',
            data: 'BASE64DATA',
          },
        ],
      },
    ];
    const result = convertPromptToCodexInput(prompt);
    expect(result.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'data:image/png;base64,BASE64DATA' },
      ],
    });
  });

  it('serializes JSON tool-result outputs as strings', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_x',
            toolName: 't',
            output: { type: 'json', value: { ok: true, n: 7 } },
          },
        ],
      },
    ];
    const { input } = convertPromptToCodexInput(prompt);
    expect(input[0]).toEqual({
      type: 'function_call_output',
      call_id: 'fc_x',
      output: '{"ok":true,"n":7}',
    });
  });

  it('returns undefined instructions when no system messages are provided', () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(convertPromptToCodexInput(prompt).instructions).toBeUndefined();
  });
});

describe('convertTools', () => {
  it('maps function tools to the Codex shape', () => {
    const warnings: SharedV3Warning[] = [];
    const tools = convertTools(
      [
        {
          type: 'function',
          name: 'search',
          description: 'Search the web',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      warnings,
    );
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        strict: undefined,
      },
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('warns and skips provider tools', () => {
    const warnings: SharedV3Warning[] = [];
    const tools = convertTools(
      [{ type: 'provider', id: 'openai.web_search', name: 'web_search', args: {} }],
      warnings,
    );
    expect(tools).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.type).toBe('unsupported');
  });

  it('sanitizes the parameter schema for strict-mode tools', () => {
    const warnings: SharedV3Warning[] = [];
    const tools = convertTools(
      [
        {
          type: 'function',
          name: 'lookup',
          inputSchema: {
            type: 'object',
            // Deliberately leave additionalProperties unset and required missing.
            properties: {
              q: { type: 'string', pattern: '^[a-z]+$' },
              topK: { type: 'integer', default: 5 },
            },
          },
          strict: true,
        },
      ],
      warnings,
    );

    const params = tools![0]!.parameters as Record<string, unknown>;
    expect(params.additionalProperties).toBe(false);
    expect(params.required).toEqual(['q', 'topK']);
    const props = params.properties as Record<string, Record<string, unknown> | undefined>;
    expect(props.q?.pattern).toBeUndefined();
    expect(props.topK?.default).toBeUndefined();
  });

  it('does not mutate strict=false tool schemas', () => {
    const schema = { type: 'object' as const, properties: { q: { type: 'string' as const } } };
    const warnings: SharedV3Warning[] = [];
    const tools = convertTools(
      [
        {
          type: 'function',
          name: 'lookup',
          inputSchema: schema,
        },
      ],
      warnings,
    );
    expect(tools![0]!.parameters).toBe(schema);
  });
});

describe('reasoning round-trip', () => {
  it('echoes assistant reasoning parts back as input reasoning items', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'I considered the options.',
            providerOptions: {
              'codex-direct': { itemId: 'rs_123', encryptedContent: 'opaque-blob' },
            },
          },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    ];

    const { input } = convertPromptToCodexInput(prompt);
    expect(input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_123',
        encrypted_content: 'opaque-blob',
        summary: [{ type: 'summary_text', text: 'I considered the options.' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Here is my answer.' }],
      },
    ]);
  });

  it('still emits a reasoning item when only summary text is available', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Some thoughts.' }],
      },
    ];
    const { input } = convertPromptToCodexInput(prompt);
    expect(input).toEqual([
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Some thoughts.' }],
      },
    ]);
  });
});

describe('sanitizeStrictSchema', () => {
  it('forces additionalProperties:false on every nested object', () => {
    const result = sanitizeStrictSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { x: { type: 'number' } },
        },
      },
    });
    expect(result.additionalProperties).toBe(false);
    expect(result.required).toEqual(['nested']);
    const nested = (result.properties as Record<string, Record<string, unknown> | undefined>)
      .nested!;
    expect(nested.additionalProperties).toBe(false);
    expect(nested.required).toEqual(['x']);
  });

  it('strips unsupported keywords and recurses through anyOf/oneOf/items', () => {
    const result = sanitizeStrictSchema({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'string', pattern: 'x', format: 'email' },
        },
        union: {
          oneOf: [
            { type: 'string', minLength: 1 },
            { type: 'object', properties: { id: { type: 'string' } } },
          ],
        },
      },
    });
    const props = result.properties as Record<string, Record<string, unknown> | undefined>;
    const items = props.list?.items as Record<string, unknown>;
    expect(items.pattern).toBeUndefined();
    expect(items.format).toBeUndefined();
    const oneOf = props.union?.oneOf as Array<Record<string, unknown>>;
    expect(oneOf[0]?.minLength).toBeUndefined();
    expect(oneOf[1]?.additionalProperties).toBe(false);
    expect(oneOf[1]?.required).toEqual(['id']);
  });
});
