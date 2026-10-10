import { postJson, runtimeFetch, withRetries, type Fetch } from '../http.js';
import { ModelError, type LanguageModel, type ModelErrorKind, type ModelRequest, type ModelResponse, type ToolCall } from '../model.js';

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  fetch?: Fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Provider-specific fields added to every request body. */
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** How the model appears in reports; defaults to "openai:<model>". */
  id?: string;
}

/** The Chat Completions body for a request. Exported so the conversion can be tested without a network. */
export function toOpenAIBody(request: ModelRequest, model: string, extraBody: Record<string, unknown> = {}): Record<string, unknown> {
  // OpenAI caches long prompt prefixes on its own: the stable part goes first
  // so it is the same from one turn to the next.
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: `${request.system.stable}\n\n${request.system.dynamic}` },
  ];
  for (const entry of request.transcript) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
    } else if (entry.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: entry.text.trim() === '' ? null : entry.text,
        ...(entry.toolCalls.length === 0
          ? {}
          : {
              tool_calls: entry.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }),
      });
    } else {
      messages.push({ role: 'tool', tool_call_id: entry.callId, content: JSON.stringify(entry.output) });
    }
  }
  return {
    ...extraBody,
    model,
    max_completion_tokens: request.maxOutputTokens,
    tools: request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    })),
    messages,
  };
}

interface OpenAIAnswer {
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** OpenRouter only, in US dollars, when usage accounting is asked for. */
    cost?: number;
  };
}

export function fromOpenAIAnswer(answer: unknown): ModelResponse {
  const message = (answer as OpenAIAnswer).choices?.[0]?.message;
  if (!message) throw new ModelError('invalid_response', 'The answer has no message');
  const toolCalls: ToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    if (typeof call.id !== 'string' || typeof call.function?.name !== 'string') continue;
    let input: unknown;
    try {
      input = JSON.parse(typeof call.function.arguments === 'string' ? call.function.arguments : '');
    } catch {
      // Malformed arguments reach the tool as they are; it answers "invalid_input" and the model can try again.
      input = undefined;
    }
    toolCalls.push({ id: call.id, name: call.function.name, input });
  }
  const usage = (answer as OpenAIAnswer).usage ?? {};
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: typeof message.content === 'string' ? message.content.trim() : '',
    toolCalls,
    usage: {
      inputTokens: (usage.prompt_tokens ?? 0) - cached,
      cacheWriteTokens: 0,
      cachedInputTokens: cached,
      outputTokens: usage.completion_tokens ?? 0,
    },
    ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? { costUsd: usage.cost } : {}),
  };
}

function classify(status: number, body: string): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth';
  // OpenAI answers 429 both for "slow down" and for "out of credit"; only the first is worth a retry.
  if (status === 429) return body.includes('insufficient_quota') ? 'quota' : 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export function openAIModel(options: OpenAIOptions): LanguageModel {
  const fetch = options.fetch ?? runtimeFetch();
  const url = `${options.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;
  const headers = { ...options.extraHeaders, authorization: `Bearer ${options.apiKey}` };
  return {
    id: options.id ?? `openai:${options.model}`,
    async complete(request) {
      const answer = await withRetries(
        () =>
          postJson(fetch, url, headers, toOpenAIBody(request, options.model, options.extraBody), options.timeoutMs ?? 30_000, classify),
        options.maxRetries ?? 2,
      );
      return fromOpenAIAnswer(answer);
    },
  };
}

export interface OpenRouterOptions {
  apiKey: string;
  /** OpenRouter's model id, such as "anthropic/claude-haiku-5.5". */
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Only route to providers that neither store nor train on prompts. On by
   * default: conversations carry guests' names and dietary needs.
   */
  denyDataCollection?: boolean;
}

/** Any model on OpenRouter, through its OpenAI-compatible API, with the exact cost of each call. */
export function openRouterModel(options: OpenRouterOptions): LanguageModel {
  return openAIModel({
    apiKey: options.apiKey,
    model: options.model,
    id: `openrouter:${options.model}`,
    baseUrl: 'https://openrouter.ai/api',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    extraHeaders: { 'X-Title': 'Maitre' },
    extraBody: {
      usage: { include: true },
      ...(options.denyDataCollection === false ? {} : { provider: { data_collection: 'deny' } }),
    },
  });
}
