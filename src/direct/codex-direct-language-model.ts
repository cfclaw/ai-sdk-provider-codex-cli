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
import { makeProxyAwareFetch } from './proxy.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_ORIGINATOR = 'ai-sdk-provider-codex-direct';

const providerOptionsSchema: z.ZodType<CodexDirectProviderOptions> = z
  .object({
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    reasoningSummary: z.enum(['auto', 'concise', 'detailed']).optional(),
    textVerbosity: z.enum(['low', 'medium', 'high']).optional(),
    store: z.boolean().optional(),
    previousResponseId: z.string().optional(),
    include: z.array(z.string()).optional(),
  })
  .strict();

const REASONING_INCLUDE_FLAG = 'reasoning.encrypted_content';

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
    const baseLogger = getLogger(this.settings.logger);
    this.logger = createVerboseLogger(baseLogger, this.settings.verbose ?? false);
    // Default to a proxy-aware fetch that honors HTTP_PROXY / HTTPS_PROXY /
    // NO_PROXY at request time. Callers can override this for tests or to
    // wire up SOCKS support themselves.
    this.fetchImpl = init.fetch ?? makeProxyAwareFetch(this.logger);
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
            if (part.providerMetadata) block.providerMetadata = part.providerMetadata;
            reasoningBlocks.set(part.id, block);
            content.push(block);
            break;
          }
          case 'reasoning-delta': {
            const block = reasoningBlocks.get(part.id);
            if (block) block.text += part.delta;
            break;
          }
          case 'reasoning-end': {
            const block = reasoningBlocks.get(part.id);
            if (block && part.providerMetadata) {
              block.providerMetadata = part.providerMetadata;
            }
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

    if (providerOptions?.previousResponseId) {
      body.previous_response_id = providerOptions.previousResponseId;
      // The API requires `store: true` to look up a prior response. If the
      // caller forgot, set it for them — silently failing here would be
      // worse than implicitly enabling the only mode that makes the request
      // valid.
      body.store = true;
    }

    // Always opt into encrypted reasoning so multi-step tool loops can echo
    // reasoning state back on follow-up turns. Merge with any extra flags
    // the caller asked for, deduped.
    const includeFlags = new Set<string>([REASONING_INCLUDE_FLAG]);
    for (const flag of providerOptions?.include ?? []) {
      if (typeof flag === 'string' && flag.length > 0) includeFlags.add(flag);
    }
    body.include = [...includeFlags];

    const url = `${this.baseUrl}/codex/responses`;
    const response = await this.executeRequest(url, body, options.abortSignal, options.headers);

    const stream = this.buildStreamPipeline(response.body!, warnings);

    return {
      stream,
      request: { body },
      response: { headers: headersToRecord(response.headers) },
    };
  }

  /**
   * POST to /codex/responses with current OAuth tokens. On a 401 we assume
   * server-side revocation, force a token refresh, and retry exactly once.
   * Any other non-2xx is surfaced as an `APICallError`.
   */
  private async executeRequest(
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    extraHeaders: Record<string, string | undefined> | undefined,
  ): Promise<Response> {
    const buildAndSend = async (forceRefresh: boolean): Promise<Response> => {
      const accessToken = forceRefresh
        ? await this.authManager.forceRefresh()
        : await this.authManager.getAccessToken();
      const accountId = await this.authManager.getAccountId();
      const headers = this.buildHeaders(accessToken, accountId, extraHeaders);
      try {
        return await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
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
    };

    let response = await buildAndSend(false);

    if (response.status === 401) {
      // Drain the body so the connection can be reused.
      try {
        await response.text();
      } catch {
        /* ignore */
      }
      this.logger.info('[codex-direct] 401 received; refreshing tokens and retrying once.');
      response = await buildAndSend(true);
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

    return response;
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
      'User-Agent': 'ai-sdk-provider-codex-direct',
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

        // We hold off on emitting `response-metadata` until we've observed
        // the server's `response.created` event so that callers see the real
        // upstream response id (matching OpenAI's usage logs). If the server
        // never sends one, we synthesize an id at the latest possible moment.
        let serverResponseId: string | undefined;
        let responseMetadataEmitted = false;
        const ensureResponseMetadata = () => {
          if (responseMetadataEmitted) return;
          controller.enqueue({
            type: 'response-metadata',
            id: serverResponseId ?? generateId(),
            modelId,
            timestamp: new Date(),
          });
          responseMetadataEmitted = true;
        };

        let activeTextId: string | undefined;
        const reasoningItems = new Map<
          string,
          { itemId: string; encryptedContent?: string; closed: boolean }
        >();
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

        const closeReasoning = (itemId: string) => {
          const entry = reasoningItems.get(itemId);
          if (!entry || entry.closed) return;
          entry.closed = true;
          const providerMetadata: SharedV3ProviderMetadata = {
            'codex-direct': {
              itemId: entry.itemId,
              ...(entry.encryptedContent ? { encryptedContent: entry.encryptedContent } : {}),
            },
          };
          controller.enqueue({ type: 'reasoning-end', id: entry.itemId, providerMetadata });
        };

        const closeAllReasoning = () => {
          for (const id of reasoningItems.keys()) closeReasoning(id);
        };

        try {
          for await (const event of iterateSseEvents(body)) {
            if (event === SSE_DONE) break;
            const type = event.type as string | undefined;

            if (type === 'response.created' || type === 'response.in_progress') {
              const r = event.response as Record<string, unknown> | undefined;
              const id = r?.id;
              if (typeof id === 'string' && id.length > 0) serverResponseId = id;
              ensureResponseMetadata();
              continue;
            }

            // Lazy-emit response-metadata before any content, so callers
            // always see it in front of text/reasoning/tool deltas.
            ensureResponseMetadata();

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
              const itemId = (event.item_id as string | undefined) ?? '__default_reasoning__';
              if (!reasoningItems.has(itemId)) {
                reasoningItems.set(itemId, { itemId, closed: false });
                controller.enqueue({ type: 'reasoning-start', id: itemId });
              }
              controller.enqueue({
                type: 'reasoning-delta',
                id: itemId,
                delta: event.delta,
              });
              continue;
            }

            if (type === 'response.reasoning_summary_text.done') {
              // Don't close yet — we still want the encrypted_content from
              // the matching output_item.done event below. Just no-op here.
              continue;
            }

            if (type === 'response.output_item.added') {
              const item = event.item as Record<string, unknown> | undefined;
              const outputIndex = event.output_index as number | undefined;
              if (item?.type === 'reasoning') {
                const itemId = (item.id as string) ?? `reasoning_${outputIndex ?? 0}`;
                if (!reasoningItems.has(itemId)) {
                  reasoningItems.set(itemId, { itemId, closed: false });
                  controller.enqueue({ type: 'reasoning-start', id: itemId });
                }
              } else if (item?.type === 'function_call' && typeof outputIndex === 'number') {
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
                const itemId = (item.id as string) ?? `reasoning_${outputIndex ?? 0}`;
                const entry = reasoningItems.get(itemId) ?? {
                  itemId,
                  closed: false,
                };
                const enc = item.encrypted_content;
                if (typeof enc === 'string' && enc.length > 0) entry.encryptedContent = enc;
                reasoningItems.set(itemId, entry);
                closeReasoning(itemId);
              }
              continue;
            }

            if (
              type === 'response.completed' ||
              type === 'response.done' ||
              type === 'response.incomplete'
            ) {
              closeText();
              closeAllReasoning();
              const responseObj = event.response as Record<string, unknown> | undefined;
              if (responseObj) {
                const id = responseObj.id;
                if (typeof id === 'string' && id.length > 0) serverResponseId = id;

                const u = responseObj.usage as
                  | {
                      input_tokens?: number;
                      output_tokens?: number;
                      total_tokens?: number;
                      input_tokens_details?: { cached_tokens?: number };
                      output_tokens_details?: { reasoning_tokens?: number };
                    }
                  | undefined;
                if (u) {
                  const cached = u.input_tokens_details?.cached_tokens;
                  const totalIn = u.input_tokens;
                  const noCache =
                    typeof totalIn === 'number' && typeof cached === 'number'
                      ? Math.max(totalIn - cached, 0)
                      : totalIn;
                  usage = {
                    inputTokens: {
                      total: totalIn,
                      noCache,
                      cacheRead: cached,
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
              closeAllReasoning();
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
          closeAllReasoning();
          ensureResponseMetadata();
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
        closeAllReasoning();
        ensureResponseMetadata();
        if (!finishEmitted) {
          const providerMetadata: SharedV3ProviderMetadata | undefined = serverResponseId
            ? { 'codex-direct': { responseId: serverResponseId } }
            : undefined;
          controller.enqueue({
            type: 'finish',
            usage,
            finishReason,
            ...(providerMetadata ? { providerMetadata } : {}),
          });
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
