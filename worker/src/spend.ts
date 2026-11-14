import { MAX_OUTPUT_TOKENS } from '../../src/agent/agent.js';
import { runtimeFetch, type Fetch } from '../../src/agent/http.js';
import { ModelError } from '../../src/agent/model.js';
import { utf8Length } from '../../src/agent/size.js';

/** What a million tokens cost at most, in US dollars, on the models a restaurant may answer with. */
export interface TokenPrices {
  inputPerMillion: number;
  outputPerMillion: number;
}

interface SpendOptions {
  /** How a request the provider did not price is counted. Without prices, only what the provider reports counts. */
  prices?: TokenPrices | undefined;
  /** Asked before every request: false stops it from leaving, and the turn ends as it does when the model fails. */
  mayCall?: () => boolean;
  /** Told what each request costs: first the most it could, then the difference once the provider has said. */
  onSpend?: (usd: number) => void;
  fetch?: Fetch;
}

/** A request is counted at one token for every two bytes it sends: twice what ordinary text weighs, at four bytes a token. */
const TOKENS_PER_BYTE = 0.5;

/**
 * What one turn spends on the model. Every request is counted before it leaves, at the most it could cost, and
 * that is replaced by what the provider reports once it answers. A request that timed out, or came back
 * without its cost, stays counted: the provider may have run it all the same, and bills it then.
 */
export class ModelSpend {
  /** What the turn has cost so far, in US dollars. */
  usd = 0;
  readonly #options: SpendOptions;
  readonly #fetch: Fetch;

  constructor(options: SpendOptions = {}) {
    this.#options = options;
    this.#fetch = options.fetch ?? runtimeFetch();
  }

  /** The fetch to give the model: the provider's answer passes through as it came. */
  readonly fetch: Fetch = async (url, init) => {
    if (this.#options.mayCall?.() === false) throw new ModelError('quota', 'The restaurant has spent what it may on the model');
    const atMost = this.#price(utf8Length(init.body) * TOKENS_PER_BYTE, MAX_OUTPUT_TOKENS);
    this.#add(atMost);
    const response = await this.#fetch(url, init);
    const text = await response.text();
    this.#add(this.#billed(response.ok, text, atMost) - atMost);
    return { ok: response.ok, status: response.status, headers: response.headers, text: async () => text };
  };

  #add(usd: number): void {
    this.usd += usd;
    this.#options.onSpend?.(usd);
  }

  #price(inputTokens: number, outputTokens: number): number {
    const prices = this.#options.prices;
    return prices ? (inputTokens * prices.inputPerMillion + outputTokens * prices.outputPerMillion) / 1_000_000 : 0;
  }

  /** What an answered request cost: what the provider says, or its tokens at the highest price, or the most it could. */
  #billed(ok: boolean, text: string, atMost: number): number {
    // A request the provider answers with an error is one it did not run, and does not bill.
    if (!ok) return 0;
    try {
      const usage = (JSON.parse(text) as { usage?: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
      if (isAmount(usage?.cost)) return usage.cost;
      if (isAmount(usage?.prompt_tokens) && isAmount(usage.completion_tokens)) return this.#price(usage.prompt_tokens, usage.completion_tokens);
    } catch {
      // Not JSON: the request may have run, and nothing says what it cost.
    }
    return atMost;
  }
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
