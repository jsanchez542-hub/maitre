import type { ToolDefinition, ToolOutput } from '../tools.js';

/**
 * A conversation in one shape, whatever the provider. Each provider adapter
 * turns it into its own request format and its answer back into this one.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** As the model sent it. It is checked by the tool before anything runs. */
  input: unknown;
}

export type TranscriptEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; output: ToolOutput };

export interface Usage {
  /** Input read at full price. */
  inputTokens: number;
  /** Input written to the provider's prompt cache. */
  cacheWriteTokens: number;
  /** Input read back from the cache, much cheaper. */
  cachedInputTokens: number;
  outputTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, cacheWriteTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * Split in two so providers can cache the long part: the rules and the business
 * do not change between turns, today's date and time do.
 */
/**
 * The reply that ended the turn before the guest's last message, or -1. The
 * conversation up to it stays the same in the next turn: a cache breakpoint
 * there lets the next turn read it instead of paying for it again.
 */
export function previousReply(transcript: readonly TranscriptEntry[], lastGuest: number): number {
  const before = transcript[lastGuest - 1];
  return lastGuest > 0 && before?.role === 'assistant' && before.toolCalls.length === 0 && before.text.trim() !== '' ? lastGuest - 1 : -1;
}

export interface SystemPrompt {
  /** The rules, the tools' guidance and the menu: the same all day, and cached. */
  stable: string;
  /** Today's date and the greeting: the same for the whole conversation. */
  dynamic: string;
  /**
   * The time at the restaurant, said after the guest's last message. In the
   * system prompt, a part that changed every minute came before the whole
   * conversation, and a minute later none of its cached prefix could be used.
   */
  now: string;
}

export interface ModelRequest {
  system: SystemPrompt;
  transcript: readonly TranscriptEntry[];
  tools: readonly ToolDefinition[];
  maxOutputTokens: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** What the call cost in US dollars, when the provider reports it (OpenRouter does). */
  costUsd?: number;
  /** Who served the call, when a router chose: OpenRouter names the provider, such as "Anthropic" or "Amazon Bedrock". */
  servedBy?: string;
}

export interface LanguageModel {
  /** "provider:model", as it appears in reports. */
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelErrorKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'overloaded'
  | 'server'
  | 'auth'
  | 'quota'
  | 'bad_request'
  | 'invalid_response';

const RETRYABLE: readonly ModelErrorKind[] = ['timeout', 'network', 'rate_limited', 'overloaded', 'server'];

/** A failed model call. Its message never contains a key or a full request. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | undefined;
  /** Seconds the provider asked to wait, when it said so. */
  readonly retryAfter: number | undefined;

  constructor(kind: ModelErrorKind, message: string, status?: number, retryAfter?: number) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  get retryable(): boolean {
    return RETRYABLE.includes(this.kind);
  }
}
