import { describe, expect, it } from 'vitest';
import type { Fetch } from '../../src/agent/http.js';
import { ModelError } from '../../src/agent/model.js';
import { ModelSpend } from '../src/spend.js';

const PRICES = { inputPerMillion: 0.25, outputPerMillion: 1.2 };
/** 4,000 bytes of request: 2,000 tokens at the most, and a reply of 700. */
const REQUEST = { method: 'POST' as const, headers: {}, body: 'x'.repeat(4000) };
const AT_MOST = (2000 * 0.25 + 700 * 1.2) / 1_000_000;

function answering(status: number, body: string): Fetch {
  return async () => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => body });
}

function spendWith(fetch: Fetch, priced = true): { spend: ModelSpend; steps: number[] } {
  const steps: number[] = [];
  return { spend: new ModelSpend({ prices: priced ? PRICES : undefined, fetch, onSpend: (usd) => steps.push(usd) }), steps };
}

describe('what a turn spends on the model', () => {
  it('is what the provider reports, and the answer passes through as it came', async () => {
    const body = JSON.stringify({ choices: [], usage: { prompt_tokens: 1500, completion_tokens: 40, cost: 0.0007 } });
    const { spend, steps } = spendWith(answering(200, body));
    const response = await spend.fetch('https://model.test', REQUEST);
    expect([response.ok, response.status, await response.text()]).toEqual([true, 200, body]);
    expect(spend.usd).toBeCloseTo(0.0007, 12);
    // Counted at the most it could cost while it was on its way, then set right.
    expect(steps[0]).toBeCloseTo(AT_MOST, 12);
    expect(steps.reduce((sum, usd) => sum + usd, 0)).toBeCloseTo(0.0007, 12);
  });

  it('is the tokens at the highest price when the provider reports them without a cost', async () => {
    const { spend } = spendWith(answering(200, JSON.stringify({ usage: { prompt_tokens: 6000, completion_tokens: 100 } })));
    await spend.fetch('https://model.test', REQUEST);
    expect(spend.usd).toBeCloseTo(0.00162, 12);
  });

  it('is the most the request could cost when the answer says nothing of it', async () => {
    for (const body of ['{}', 'null', '<html>Bad gateway</html>', JSON.stringify({ usage: { cost: -1, prompt_tokens: 'many' } })]) {
      const { spend } = spendWith(answering(200, body));
      await spend.fetch('https://model.test', REQUEST);
      expect(spend.usd).toBeCloseTo(AT_MOST, 12);
    }
  });

  it('is nothing when the provider answers that it did not run the request', async () => {
    const { spend } = spendWith(answering(503, JSON.stringify({ error: { message: 'overloaded' } })));
    expect((await spend.fetch('https://model.test', REQUEST)).status).toBe(503);
    expect(spend.usd).toBeCloseTo(0, 12);
  });

  it('stays at the most the request could cost when no answer comes', async () => {
    const { spend } = spendWith(async () => {
      throw new Error('the connection dropped');
    });
    await expect(spend.fetch('https://model.test', REQUEST)).rejects.toThrow('the connection dropped');
    expect(spend.usd).toBeCloseTo(AT_MOST, 12);
  });

  it('weighs a request by its bytes: an emoji is four, not the two characters a string counts', async () => {
    const { spend } = spendWith(answering(200, '{}'));
    await spend.fetch('https://model.test', { ...REQUEST, body: String.fromCodePoint(0x1f377).repeat(1000) });
    expect(spend.usd).toBeCloseTo(AT_MOST, 12);
  });

  it('does not send a request the restaurant may no longer make', async () => {
    let sent = 0;
    const spend = new ModelSpend({
      prices: PRICES,
      mayCall: () => false,
      fetch: async () => {
        sent += 1;
        return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' };
      },
    });
    const refused = await spend.fetch('https://model.test', REQUEST).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ModelError);
    expect(refused).toMatchObject({ kind: 'quota', retryable: false });
    expect([sent, spend.usd]).toEqual([0, 0]);
  });

  it('counts only what the provider reports when there is no price to count the rest by', async () => {
    const reported = spendWith(answering(200, JSON.stringify({ usage: { cost: 0.0007 } })), false);
    await reported.spend.fetch('https://model.test', REQUEST);
    expect(reported.spend.usd).toBeCloseTo(0.0007, 12);
    const silent = spendWith(answering(200, '{}'), false);
    await silent.spend.fetch('https://model.test', REQUEST);
    expect(silent.spend.usd).toBe(0);
  });
});
