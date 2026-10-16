import type { DemoBudget, DemoRestaurant } from './demo.js';
import type { Restaurant } from './restaurant.js';

export interface Env {
  RESTAURANTS: DurableObjectNamespace<Restaurant>;
  /** One restaurant per visitor of the public demo, each with the demo evening of its own. */
  DEMO_RESTAURANTS: DurableObjectNamespace<DemoRestaurant>;
  /** What the public demo has spent, today and this month, and how many restaurants each visitor opened today. */
  DEMO_BUDGET: DurableObjectNamespace<DemoBudget>;
  /** Requests per visitor address per minute, across the API: what one address may spend of what all share. */
  API_LIMITER?: RateLimit;
  /**
   * "eu" keeps every restaurant's data in the European Union. Only local runs
   * set "none", because workerd cannot pin data to a jurisdiction; any other
   * value leaves the restaurant routes unconfigured rather than unpinned.
   */
  DATA_JURISDICTION: string;
  /** OpenRouter id of the model the assistant uses, chosen with the evaluation. */
  MODEL: string;
  /** The model for phone calls, when it is not MODEL: chosen with its own test, where every second of silence is heard. */
  VOICE_MODEL?: string;
  /** The model that answers when MODEL's providers are down, overloaded or stalled. It must have passed the same evaluation. */
  FALLBACK_MODEL?: string;
  /** Comma-separated restaurant ids this deployment serves. Any other id is "not found". */
  RESTAURANT_IDS: string;
  /** The public demo's spending limits in dollars, a day and a month. Missing or unreadable keeps the demo paused. */
  DEMO_DAILY_USD: string;
  DEMO_MONTHLY_USD: string;
  /** Demo restaurants one visitor may open in a day. */
  DEMO_SANDBOXES_PER_IP: string;
  /** Messages one demo restaurant takes in its whole life. */
  DEMO_MESSAGES_PER_SANDBOX: string;
  /** Calls one demo restaurant may make, the longest a demo call lasts in seconds, and what a minute of voice costs the demo's budget. */
  DEMO_CALLS_PER_SANDBOX: string;
  DEMO_CALL_SECONDS: string;
  DEMO_VOICE_USD_PER_MINUTE: string;
  /** The LiveKit project that carries calls from the browser (wss://…), and the name its voice agent registers under. */
  LIVEKIT_URL?: string;
  LIVEKIT_AGENT_NAME: string;
  /** Secrets. Without them the routes that need them answer 503 rather than run open. */
  OPENROUTER_API_KEY?: string;
  /** For the services that talk on the guest's behalf: the web chat backend and the voice agent. */
  AGENT_TOKEN?: string;
  /** For the restaurant's dashboard. */
  STAFF_TOKEN?: string;
  /** The public demo's own OpenRouter key, with a credit limit set at OpenRouter: a ceiling under the demo's own count. */
  DEMO_OPENROUTER_API_KEY?: string;
  /** Cloudflare Turnstile's secret, which tells a person opening a demo restaurant from a script. */
  TURNSTILE_SECRET?: string;
  /** The LiveKit project's key and secret, which sign the pass a browser needs to call. */
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

/** The namespace that keeps its data where the deployment says, or undefined when it does not say. */
function pinned<T extends Rpc.DurableObjectBranded | undefined>(env: Env, namespace: DurableObjectNamespace<T>): DurableObjectNamespace<T> | undefined {
  return env.DATA_JURISDICTION === 'eu' ? namespace.jurisdiction('eu') : env.DATA_JURISDICTION === 'none' ? namespace : undefined;
}

/** The Durable Object of one restaurant, or undefined when the deployment does not say where data may live. */
export function restaurantStub(env: Env, restaurantId: string): DurableObjectStub<Restaurant> | undefined {
  const namespace = pinned(env, env.RESTAURANTS);
  return namespace?.get(namespace.idFromName(restaurantId));
}

/** A visitor's demo restaurant, by the id it was opened with. */
export function demoStub(env: Env, sandboxId: string): DurableObjectStub<DemoRestaurant> | undefined {
  const namespace = pinned(env, env.DEMO_RESTAURANTS);
  return namespace?.get(namespace.idFromName(sandboxId));
}

/** The single object that keeps the public demo's spending. */
export function budgetStub(env: Env): DurableObjectStub<DemoBudget> | undefined {
  const namespace = pinned(env, env.DEMO_BUDGET);
  return namespace?.get(namespace.idFromName('budget'));
}
