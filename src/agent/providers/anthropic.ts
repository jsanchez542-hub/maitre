import { postJson, runtimeFetch, withRetries, type Fetch } from '../http.js';
import { ModelError, previousReply, type LanguageModel, type ModelErrorKind, type ModelRequest, type ModelResponse, type ToolCall } from '../model.js';

const EPHEMERAL = { type: 'ephemeral' } as const;

export interface AnthropicOptions {
  apiKey: string;
  /** Such as "claude-haiku-4-5-20251001". */
  model: string;
  fetch?: Fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

type ContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/** The Messages API body for a request. Exported so the conversion can be tested without a network. */
export function toAnthropicBody(request: ModelRequest, model: string): Record<string, unknown> {
  const messages: Message[] = [];
  const push = (role: Message['role'], blocks: ContentBlock[]): void => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    // The API wants user and assistant turns to alternate: consecutive entries
    // of one side (two guest messages, or several tool results) become one turn.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  // As in the OpenAI format: the time goes after the guest's last message, and the conversation is cached up to
  // the reply that ended the turn before and up to the time.
  const lastGuest = request.transcript.map((entry) => entry.role).lastIndexOf('user');
  const lastReply = previousReply(request.transcript, lastGuest);
  for (const [index, entry] of request.transcript.entries()) {
    if (entry.role === 'user') {
      const now = index === lastGuest ? request.system.now : '';
      push('user', [{ type: 'text', text: entry.text }, ...(now === '' ? [] : [{ type: 'text' as const, text: now, cache_control: EPHEMERAL }])]);
    } else if (entry.role === 'assistant') {
      push('assistant', [
        ...(entry.text.trim() === '' ? [] : [{ type: 'text' as const, text: entry.text, ...(index === lastReply ? { cache_control: EPHEMERAL } : {}) }]),
        ...entry.toolCalls.map((call) => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.input ?? {} })),
      ]);
    } else {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: entry.callId,
          content: JSON.stringify(entry.output),
          ...(entry.output.status === 'internal_error' ? { is_error: true } : {}),
        },
      ]);
    }
  }

  return {
    model,
    max_tokens: request.maxOutputTokens,
    // The breakpoint on the stable block caches the tools and the rules, which
    // come before it in the prompt. Today's date and the greeting follow.
    system: [
      { type: 'text', text: request.system.stable, cache_control: EPHEMERAL },
      { type: 'text', text: request.system.dynamic },
    ],
    tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
    messages,
  };
}

interface AnthropicAnswer {
  content?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function fromAnthropicAnswer(answer: unknown): ModelResponse {
  const parsed = answer as AnthropicAnswer;
  if (!Array.isArray(parsed.content)) throw new ModelError('invalid_response', 'The answer has no content');
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of parsed.content as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown }[]) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  const usage = parsed.usage ?? {};
  return {
    text: texts.join('\n').trim(),
    toolCalls,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    },
  };
}

function classify(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export function anthropicModel(options: AnthropicOptions): LanguageModel {
  const fetch = options.fetch ?? runtimeFetch();
  const url = `${options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
  const headers = { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' };
  return {
    id: `anthropic:${options.model}`,
    async complete(request) {
      const answer = await withRetries(
        () => postJson(fetch, url, headers, toAnthropicBody(request, options.model), options.timeoutMs ?? 30_000, classify),
        options.maxRetries ?? 2,
      );
      return fromAnthropicAnswer(answer);
    },
  };
}
