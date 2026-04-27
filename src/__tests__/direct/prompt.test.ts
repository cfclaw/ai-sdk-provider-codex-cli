import { describe, expect, it } from 'vitest';
import {
  convertPromptToCodexInput,
  convertTools,
  fromCodexId,
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
});
