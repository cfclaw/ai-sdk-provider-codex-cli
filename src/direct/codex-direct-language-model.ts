import {
  APICallError,
  NoSuchModelError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Reasoning,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Text,
  type LanguageModelV3ToolCall,
  type LanguageModelV3Usage,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from '@ai-sdk/provider';
import { generateId, parseProviderOptions } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import type { CodexAuthManager } from './auth-manager.js';
import {
  convertPromptToCodexInput,
  convertTools,
  fromCodexId,
  DEFAULT_INSTRUCTION_FALLBACK,
} from './prompt.js';
import { iterateSseEvents, SSE_DONE } from './sse.js';
import type { CodexDirectProviderOptions, CodexDirectSettings } from './types.js';
import type { CodexModelId } from '../types-shared.js';
import { getLogger, createVerboseLogger } from '../logger.js';
import type { Logger } from '../types-shared.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_ORIGINATOR = 'ai-sdk-provider-codex-cli';

const providerOptionsSchema: z.ZodType<CodexDirectProviderOptions> = z
  .object({
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    reasoningSummary: z.enum(['auto', 'concise', 'detailed']).optional(),
    textVerbosity: z.enum(['low', 'medium', 'high']).optional(),
    store: z.boolean().optional(),
  })
  .strict();

export interface CodexDirectLanguageModelInit {
  modelId: CodexModelId;
  authManager: CodexAuthManager;
  settings?: CodexDirectSettings;
  baseUrl?: string;
  fetch?: typeof fetch;
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    raw: undefined,
  };
}

function mapFinishReason(raw: string | undefined): LanguageModelV3FinishReason {
  switch (raw) {
    case 'stop':
    case 'completed':
    case undefined:
      return { unified: 'stop', raw };
    case 'length':
    case 'max_output_tokens':
    case 'incomplete':
      return { unified: 'length', raw };
    case 'content_filter':
    case 'safety':
      return { unified: 'content-filter', raw };
    case 'tool_calls':
    case 'function_call':
      return { unified: 'tool-calls', raw };
    case 'error':
    case 'failed':
      return { unified: 'error', raw };
    default:
      return { unified: 'other', raw };
  }
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  emittedStart: boolean;
}

export class CodexDirectLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'codex-direct';
  readonly supportedUrls: Record<string, RegExp[]> = {
    'image/*': [/^https?:\/\/.+/i],
  };

  readonly modelId: string;
  private readonly authManager: CodexAuthManager;
  private readonly settings: CodexDirectSettings;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(init: CodexDirectLanguageModelInit) {
    if (!init.modelId || init.modelId.trim() === '') {
      throw new NoSuchModelError({ modelId: init.modelId, modelType: 'languageModel' });
    }
    this.modelId = init.modelId;
    this.authManager = init.authManager;
    this.settings = init.settings ?? {};
    this.baseUrl = (init.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = init.fetch ?? fetch;
    const baseLogger = getLogger(this.settings.logger);
    this.logger = createVerboseLogger(baseLogger, this.settings.verbose ?? false);
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream, request, response } = await this.doStream(options);

    const content: LanguageModelV3Content[] = [];
    const textBlocks = new Map<string, LanguageModelV3Text>();
    const reasoningBlocks = new Map<string, LanguageModelV3Reasoning>();
    let usage: LanguageModelV3Usage = emptyUsage();
    let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
    let warnings: SharedV3Warning[] = [];
    let providerMetadata: SharedV3ProviderMetadata | undefined;

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = value;

        switch (part.type) {
          case 'stream-start':
            warnings = part.warnings;
            break;
          case 'text-start': {
            const block: LanguageModelV3Text = { type: 'text', text: '' };
            textBlocks.set(part.id, block);
            content.push(block);
            break;
          }
          case 'text-delta': {
            const block = textBlocks.get(part.id);
            if (block) block.text += part.delta;
            break;
          }
          case 'reasoning-start': {
            const block: LanguageModelV3Reasoning = { type: 'reasoning', text: '' };
            reasoningBlocks.set(part.id, block);
            content.push(block);
            break;
          }
          case 'reasoning-delta': {
            const block = reasoningBlocks.get(part.id);
            if (block) block.text += part.delta;
            break;
          }
          case 'tool-call':
            content.push(part as LanguageModelV3ToolCall);
            break;
          case 'finish':
            usage = part.usage;
            finishReason = part.finishReason;
            providerMetadata = part.providerMetadata;
            break;
          default:
            break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const normalized = content.filter((c) => {
      if (c.type === 'text') return c.text.length > 0;
      if (c.type === 'reasoning') return c.text.length > 0;
      return true;
    });

    return {
      content: normalized,
      usage,
      finishReason,
      warnings,
      ...(providerMetadata ? { providerMetadata } : {}),
      ...(request ? { request } : {}),
      ...(response
        ? {
            response: {
              ...(response.headers ? { headers: response.headers } : {}),
            },
          }
        : {}),
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const warnings: SharedV3Warning[] = [];

    const providerOptions = await parseProviderOptions<CodexDirectProviderOptions>({
      provider: 'codex-direct',
      providerOptions: options.providerOptions,
      schema: providerOptionsSchema,
    });

    if (options.temperature != null) {
      warnings.push({
        type: 'unsupported',
        feature: 'temperature',
        details: 'Codex Responses API ignores temperature.',
      });
    }
    if (options.topP != null) {
      warnings.push({ type: 'unsupported', feature: 'topP' });
    }
    if (options.topK != null) {
      warnings.push({ type: 'unsupported', feature: 'topK' });
    }
    if (options.frequencyPenalty != null) {
      warnings.push({ type: 'unsupported', feature: 'frequencyPenalty' });
    }
    if (options.presencePenalty != null) {
      warnings.push({ type: 'unsupported', feature: 'presencePenalty' });
    }
    if (options.stopSequences && options.stopSequences.length > 0) {
      warnings.push({ type: 'unsupported', feature: 'stopSequences' });
    }
    if (options.seed != null) {
      warnings.push({ type: 'unsupported', feature: 'seed' });
    }

    const converted = convertPromptToCodexInput(options.prompt);
    warnings.push(...converted.warnings);
    const tools = convertTools(options.tools, warnings);

    const instructions =
      converted.instructions ?? this.settings.defaultInstructions ?? DEFAULT_INSTRUCTION_FALLBACK;

    const body: Record<string, unknown> = {
      model: this.modelId,
      instructions,
      input: converted.input,
      store: providerOptions?.store ?? false,
      stream: true,
    };

    if (options.maxOutputTokens != null) {
      body.max_output_tokens = options.maxOutputTokens;
    }
    if (tools) {
      body.tools = tools;
    }
    if (options.toolChoice) {
      body.tool_choice = mapToolChoice(options.toolChoice);
    }
    if (options.responseFormat?.type === 'json') {
      body.text = {
        format: options.responseFormat.schema
          ? {
              type: 'json_schema',
              name: options.responseFormat.name ?? 'response',
              schema: options.responseFormat.schema,
              ...(options.responseFormat.description
                ? { description: options.responseFormat.description }
                : {}),
              strict: true,
            }
          : { type: 'json_object' },
      };
    }

    if (providerOptions?.reasoningEffort) {
      const reasoning: Record<string, unknown> = { effort: providerOptions.reasoningEffort };
      if (providerOptions.reasoningSummary) {
        reasoning.summary = providerOptions.reasoningSummary;
      }
      body.reasoning = reasoning;
    }
    if (providerOptions?.textVerbosity) {
      const existingText = (body.text as Record<string, unknown> | undefined) ?? {};
      body.text = { ...existingText, verbosity: providerOptions.textVerbosity };
    }

    const accessToken = await this.authManager.getAccessToken();
    const accountId = await this.authManager.getAccountId();
    const headers = this.buildHeaders(accessToken, accountId, options.headers);

    const url = `${this.baseUrl}/codex/responses`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
    } catch (err) {
      throw new APICallError({
        url,
        message: `Codex API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        requestBodyValues: body,
        isRetryable: true,
        cause: err,
      });
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new APICallError({
        url,
        message: `Codex Responses API returned HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`,
        statusCode: response.status,
        responseBody: text,
        requestBodyValues: body,
        isRetryable: response.status >= 500 || response.status === 429,
        responseHeaders: headersToRecord(response.headers),
      });
    }

    const stream = this.buildStreamPipeline(response.body, warnings);

    return {
      stream,
      request: { body },
      response: { headers: headersToRecord(response.headers) },
    };
  }

  private buildHeaders(
    accessToken: string,
    accountId: string,
    extra: Record<string, string | undefined> | undefined,
  ): Record<string, string> {
    const merged: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      // ChatGPT backend is case-sensitive on this header.
      'ChatGPT-Account-Id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: this.settings.originator ?? DEFAULT_ORIGINATOR,
      Accept: 'text/event-stream',
      'User-Agent': 'ai-sdk-provider-codex-cli',
    };
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) merged[key] = value;
      }
    }
    return merged;
  }

  private buildStreamPipeline(
    body: ReadableStream<Uint8Array>,
    warnings: SharedV3Warning[],
  ): ReadableStream<LanguageModelV3StreamPart> {
    const modelId = this.modelId;
    const logger = this.logger;

    return new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings });

        const responseId = generateId();
        controller.enqueue({
          type: 'response-metadata',
          id: responseId,
          modelId,
          timestamp: new Date(),
        });

        let activeTextId: string | undefined;
        let activeReasoningId: string | undefined;
        const pendingToolCalls = new Map<number, PendingToolCall>();
        let usage: LanguageModelV3Usage = emptyUsage();
        let finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
        let finishEmitted = false;

        const closeText = () => {
          if (activeTextId) {
            controller.enqueue({ type: 'text-end', id: activeTextId });
            activeTextId = undefined;
          }
        };
        const closeReasoning = () => {
          if (activeReasoningId) {
            controller.enqueue({ type: 'reasoning-end', id: activeReasoningId });
            activeReasoningId = undefined;
          }
        };

        try {
          for await (const event of iterateSseEvents(body)) {
            if (event === SSE_DONE) break;
            const type = event.type as string | undefined;

            if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
              if (!activeTextId) {
                activeTextId = (event.item_id as string | undefined) ?? generateId();
                controller.enqueue({ type: 'text-start', id: activeTextId });
              }
              controller.enqueue({ type: 'text-delta', id: activeTextId, delta: event.delta });
              continue;
            }

            if (type === 'response.output_text.done') {
              closeText();
              continue;
            }

            if (
              type === 'response.reasoning_summary_text.delta' &&
              typeof event.delta === 'string'
            ) {
              if (!activeReasoningId) {
                activeReasoningId = (event.item_id as string | undefined) ?? generateId();
                controller.enqueue({ type: 'reasoning-start', id: activeReasoningId });
              }
              controller.enqueue({
                type: 'reasoning-delta',
                id: activeReasoningId,
                delta: event.delta,
              });
              continue;
            }

            if (type === 'response.reasoning_summary_text.done') {
              closeReasoning();
              continue;
            }

            if (type === 'response.output_item.added') {
              const item = event.item as Record<string, unknown> | undefined;
              const outputIndex = event.output_index as number | undefined;
              if (item?.type === 'function_call' && typeof outputIndex === 'number') {
                const rawId = (item.call_id as string) ?? (item.id as string) ?? '';
                const pending: PendingToolCall = {
                  id: fromCodexId(rawId),
                  name: (item.name as string) ?? '',
                  args: typeof item.arguments === 'string' ? item.arguments : '',
                  emittedStart: false,
                };
                pendingToolCalls.set(outputIndex, pending);
                if (pending.id && pending.name) {
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: pending.id,
                    toolName: pending.name,
                  });
                  pending.emittedStart = true;
                }
              }
              continue;
            }

            if (type === 'response.function_call_arguments.delta') {
              const outputIndex = event.output_index as number | undefined;
              const delta = event.delta as string | undefined;
              if (typeof outputIndex !== 'number' || typeof delta !== 'string') continue;
              const pending = pendingToolCalls.get(outputIndex);
              if (!pending) continue;
              pending.args += delta;
              if (pending.emittedStart) {
                controller.enqueue({ type: 'tool-input-delta', id: pending.id, delta });
              }
              continue;
            }

            if (type === 'response.output_item.done') {
              const item = event.item as Record<string, unknown> | undefined;
              const outputIndex = event.output_index as number | undefined;
              if (item?.type === 'function_call' && typeof outputIndex === 'number') {
                const pending = pendingToolCalls.get(outputIndex);
                const rawId = (item.call_id as string) ?? (item.id as string) ?? '';
                const id = pending?.id ?? fromCodexId(rawId);
                const name = (item.name as string) ?? pending?.name ?? '';
                const args =
                  typeof item.arguments === 'string' && item.arguments.length > 0
                    ? item.arguments
                    : (pending?.args ?? '');

                if (pending?.emittedStart) {
                  controller.enqueue({ type: 'tool-input-end', id });
                }
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: id,
                  toolName: name,
                  input: args,
                });
                pendingToolCalls.delete(outputIndex);
              } else if (item?.type === 'message') {
                closeText();
              } else if (item?.type === 'reasoning') {
                closeReasoning();
              }
              continue;
            }

            if (
              type === 'response.completed' ||
              type === 'response.done' ||
              type === 'response.incomplete'
            ) {
              closeText();
              closeReasoning();
              const responseObj = event.response as Record<string, unknown> | undefined;
              if (responseObj) {
                const u = responseObj.usage as
                  | {
                      input_tokens?: number;
                      output_tokens?: number;
                      total_tokens?: number;
                      output_tokens_details?: { reasoning_tokens?: number };
                    }
                  | undefined;
                if (u) {
                  usage = {
                    inputTokens: {
                      total: u.input_tokens,
                      noCache: u.input_tokens,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: u.output_tokens,
                      text: u.output_tokens,
                      reasoning: u.output_tokens_details?.reasoning_tokens,
                    },
                    raw: u as unknown as LanguageModelV3Usage['raw'],
                  };
                }
                const status = responseObj.status as string | undefined;
                const incomplete = responseObj.incomplete_details as
                  | { reason?: string }
                  | undefined;
                finishReason = mapFinishReason(
                  type === 'response.incomplete'
                    ? (incomplete?.reason ?? status ?? 'incomplete')
                    : status,
                );
              }
              continue;
            }

            if (type === 'response.failed' || type === 'error') {
              closeText();
              closeReasoning();
              const message =
                (event.error as { message?: string } | undefined)?.message ??
                (event.message as string | undefined) ??
                'Codex Responses API stream reported an error';
              controller.enqueue({ type: 'error', error: new Error(message) });
              finishReason = { unified: 'error', raw: type };
              continue;
            }

            // Unknown event — log once at debug for diagnostics, then ignore.
            if (type) {
              logger.debug(`[codex-direct] unhandled SSE event: ${type}`);
            }
          }
        } catch (err) {
          closeText();
          closeReasoning();
          controller.enqueue({ type: 'error', error: err });
          if (!finishEmitted) {
            controller.enqueue({
              type: 'finish',
              usage,
              finishReason: { unified: 'error', raw: 'stream-error' },
            });
            finishEmitted = true;
          }
          controller.close();
          return;
        }

        closeText();
        closeReasoning();
        if (!finishEmitted) {
          controller.enqueue({ type: 'finish', usage, finishReason });
          finishEmitted = true;
        }
        controller.close();
      },
    });
  }
}

function mapToolChoice(choice: LanguageModelV3CallOptions['toolChoice']): unknown {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'required') return 'required';
  if (choice.type === 'tool') {
    return { type: 'function', name: choice.toolName };
  }
  return undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
