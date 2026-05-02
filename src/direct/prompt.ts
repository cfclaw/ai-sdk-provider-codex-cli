import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ProviderTool,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  SharedV3ProviderOptions,
  SharedV3Warning,
} from '@ai-sdk/provider';
import type { CodexDirectProviderMetadata } from './types.js';

/**
 * Read the `codex-direct` slot from a part's `providerOptions`. Returns
 * `undefined` if absent or malformed.
 */
function readCodexProviderOptions(
  options: SharedV3ProviderOptions | undefined,
): CodexDirectProviderMetadata | undefined {
  if (!options) return undefined;
  const raw = options['codex-direct'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as unknown as CodexDirectProviderMetadata;
}

/**
 * The Codex Responses API uses tool-call IDs prefixed with `fc_`, but the
 * rest of the AI SDK ecosystem (history, conversations, tool registries)
 * uses the Chat Completions `call_` prefix. We translate at the boundary
 * so callers never have to think about it.
 */
export function toCodexId(id: string): string {
  if (id.startsWith('call_')) return `fc_${id.slice(5)}`;
  return id;
}

export function fromCodexId(id: string): string {
  if (id.startsWith('fc_')) return `call_${id.slice(3)}`;
  return id;
}

interface ConvertedPrompt {
  instructions: string | undefined;
  input: Array<Record<string, unknown>>;
  warnings: SharedV3Warning[];
}

const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

function isTextContent(value: unknown): value is string {
  return typeof value === 'string';
}

function joinSystemContent(message: LanguageModelV3Message & { role: 'system' }): string {
  return typeof message.content === 'string' ? message.content : '';
}

function userPartsToContent(
  parts: ReadonlyArray<{ type: string }>,
  warnings: SharedV3Warning[],
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    const typed = part as Record<string, unknown>;
    if (part.type === 'text' && isTextContent(typed.text)) {
      content.push({ type: 'input_text', text: typed.text });
      continue;
    }
    if (part.type === 'file') {
      // The Codex Responses API supports inline images for vision-capable
      // models. Files are passed by base64 data URL; we only forward
      // image media types here.
      const mediaType = String(typed.mediaType ?? '');
      if (mediaType.startsWith('image/')) {
        const url = dataToImageUrl(typed.data, mediaType);
        if (url) {
          content.push({ type: 'input_image', image_url: url });
          continue;
        }
      }
      warnings.push({
        type: 'unsupported',
        feature: 'prompt.user.file',
        details: `Unsupported user file part with mediaType "${mediaType}".`,
      });
      continue;
    }
    warnings.push({
      type: 'unsupported',
      feature: `prompt.user.${part.type}`,
      details: `Unsupported user content part "${part.type}".`,
    });
  }
  return content;
}

function dataToImageUrl(data: unknown, mediaType: string): string | null {
  if (typeof data === 'string') {
    if (data.startsWith('data:') || data.startsWith('http://') || data.startsWith('https://')) {
      return data;
    }
    return `data:${mediaType};base64,${data}`;
  }
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) {
    const base64 = Buffer.from(data).toString('base64');
    return `data:${mediaType};base64,${base64}`;
  }
  return null;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolResultToString(part: LanguageModelV3ToolResultPart): string {
  const out = part.output;
  switch (out.type) {
    case 'text':
    case 'error-text':
      return out.value;
    case 'json':
    case 'error-json':
      return safeStringify(out.value);
    case 'execution-denied':
      return `[execution denied${out.reason ? `: ${out.reason}` : ''}]`;
    case 'content': {
      const parts = out.value
        .map((piece) => {
          if (piece.type === 'text') return piece.text;
          if (piece.type === 'image-url' || piece.type === 'file-url') return piece.url;
          if (piece.type === 'image-data' || piece.type === 'file-data')
            return `[${piece.type} ${piece.mediaType}]`;
          return `[${piece.type}]`;
        })
        .filter((s) => s.length > 0);
      return parts.join('\n');
    }
    default:
      return safeStringify(out);
  }
}

/**
 * Convert an AI SDK v3 prompt into the Codex Responses API request shape.
 *
 *   - System messages collapse into a single top-level `instructions` string.
 *   - User/assistant/tool messages become `input` items.
 *   - Assistant tool calls become top-level `function_call` items, with their
 *     IDs translated to the Codex `fc_` prefix.
 *   - Tool results become `function_call_output` items keyed by `call_id`.
 */
export function convertPromptToCodexInput(prompt: LanguageModelV3Prompt): ConvertedPrompt {
  const warnings: SharedV3Warning[] = [];
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      const text = joinSystemContent(message).trim();
      if (text.length > 0) systemParts.push(text);
      continue;
    }

    if (message.role === 'user') {
      const content = userPartsToContent(message.content, warnings);
      if (content.length > 0) {
        input.push({ type: 'message', role: 'user', content });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: LanguageModelV3ToolCallPart[] = [];
      for (const part of message.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          if (part.text.length > 0) textParts.push(part.text);
        } else if (part.type === 'reasoning') {
          // Echo reasoning items back to the API so multi-step tool loops
          // preserve their hidden chain-of-thought. We rely on the
          // `codex-direct` providerOptions block populated on the prior
          // turn (see CodexDirectLanguageModel) for the encrypted content
          // and item id; without it we emit a summary-only reasoning item,
          // which still helps the model maintain context.
          const meta = readCodexProviderOptions(part.providerOptions);
          const reasoningItem: Record<string, unknown> = { type: 'reasoning' };
          if (meta?.itemId) reasoningItem.id = meta.itemId;
          if (meta?.encryptedContent) reasoningItem.encrypted_content = meta.encryptedContent;
          const summary: Array<Record<string, unknown>> = [];
          if (typeof part.text === 'string' && part.text.length > 0) {
            summary.push({ type: 'summary_text', text: part.text });
          }
          reasoningItem.summary = summary;
          input.push(reasoningItem);
          continue;
        } else if (part.type === 'tool-call') {
          toolCalls.push(part);
        } else if (part.type === 'tool-result') {
          // AI SDK occasionally surfaces provider-executed tool results on
          // the assistant message; promote them to function_call_output.
          input.push({
            type: 'function_call_output',
            call_id: toCodexId(part.toolCallId),
            output: toolResultToString(part),
          });
        }
      }

      if (textParts.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textParts.join('\n') }],
        });
      }
      for (const call of toolCalls) {
        const codexId = toCodexId(call.toolCallId);
        input.push({
          type: 'function_call',
          id: codexId,
          call_id: codexId,
          name: call.toolName,
          arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {}),
        });
      }
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          input.push({
            type: 'function_call_output',
            call_id: toCodexId(part.toolCallId),
            output: toolResultToString(part),
          });
        } else if (part.type === 'tool-approval-response') {
          // Codex responses API does not have a first-class approval channel;
          // surface the decision as a synthetic user-visible note so the model
          // can adapt rather than silently dropping it.
          input.push({
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `[tool approval ${part.approvalId}: ${part.approved ? 'approved' : 'denied'}${part.reason ? ` — ${part.reason}` : ''}]`,
              },
            ],
          });
        }
      }
      continue;
    }
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    input,
    warnings,
  };
}

/**
 * Convert AI SDK function tools to the shape the Codex Responses API expects.
 * Provider tools (`type: 'provider'`) are dropped with a warning — those are
 * provider-specific and not part of the Codex Responses surface.
 */
export function convertTools(
  tools: ReadonlyArray<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool> | undefined,
  warnings: SharedV3Warning[],
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;

  const converted: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (tool.type === 'function') {
      const strict = tool.strict === true;
      const parameters = strict
        ? sanitizeStrictSchema(tool.inputSchema)
        : (tool.inputSchema as Record<string, unknown> | undefined);
      converted.push({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters,
        strict: tool.strict,
      });
    } else {
      warnings.push({
        type: 'unsupported',
        feature: `tool.${tool.id}`,
        details: `Provider tool "${tool.id}" is not supported by codexDirect; use a function tool instead.`,
      });
    }
  }

  return converted.length > 0 ? converted : undefined;
}

/**
 * Sanitize a JSON schema for OpenAI strict-mode tools.
 *
 * Strict mode rejects schemas that:
 *   - omit `additionalProperties: false` on object types
 *   - have any property not present in `required`
 *   - use unsupported keywords like `format`, `pattern`, `default`, `examples`
 *
 * This walker enforces those constraints recursively. It also passes through
 * `oneOf` / `anyOf` / `allOf` and array `items` so nested schemas are fixed
 * up. The output is always a plain object the API will accept; the input is
 * never mutated.
 */
export function sanitizeStrictSchema(input: unknown): Record<string, unknown> {
  return walkStrictSchema(input) as Record<string, unknown>;
}

const STRICT_DROP_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'title',
  'examples',
  'default',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

function walkStrictSchema(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => walkStrictSchema(v));

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (STRICT_DROP_KEYWORDS.has(key)) continue;
    if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
      const props = val as Record<string, unknown>;
      const sanitizedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(props)) {
        sanitizedProps[propName] = walkStrictSchema(propSchema);
      }
      out[key] = sanitizedProps;
      continue;
    }
    if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(val)) {
      out[key] = val.map((v) => walkStrictSchema(v));
      continue;
    }
    if (key === 'items') {
      out[key] = walkStrictSchema(val);
      continue;
    }
    out[key] = walkStrictSchema(val);
  }

  // For object schemas, force `additionalProperties: false` and require
  // every property. This is what OpenAI strict mode demands.
  if (out.type === 'object' || (out.properties && typeof out.properties === 'object')) {
    out.additionalProperties = false;
    const props = (out.properties as Record<string, unknown> | undefined) ?? {};
    out.required = Object.keys(props);
  }

  return out;
}

export const DEFAULT_INSTRUCTION_FALLBACK = DEFAULT_INSTRUCTIONS;
