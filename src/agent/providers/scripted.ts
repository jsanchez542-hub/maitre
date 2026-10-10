import { NO_USAGE, type LanguageModel, type ModelRequest, type ModelResponse, type ToolCall } from '../model.js';

/** One answer of a scripted model: words, tool calls, or both. */
export interface ScriptedStep {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
}

/**
 * A model that answers from a script, for tests and for checking the
 * evaluation harness without a key. It records every request it receives.
 */
export function scriptedModel(steps: readonly ScriptedStep[] | ((request: ModelRequest, call: number) => ScriptedStep)): LanguageModel & {
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let calls = 0;
  return {
    id: 'scripted:test',
    requests,
    async complete(request): Promise<ModelResponse> {
      requests.push(structuredCloneSafe(request));
      const step = typeof steps === 'function' ? steps(request, calls) : steps[calls];
      calls += 1;
      if (!step) throw new Error(`The script has no answer for call ${calls}`);
      const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((call, index) => ({
        id: `call-${calls}-${index + 1}`,
        name: call.name,
        input: call.input,
      }));
      return { text: step.text ?? '', toolCalls, usage: { ...NO_USAGE, inputTokens: 100, outputTokens: 20 } };
    },
  };
}

/** A deep copy through JSON: the transcript is plain data, and later turns must not change a recorded request. */
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
