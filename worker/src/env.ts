import type { DemoBudget, DemoRestaurant } from './demo.js';
import type { Restaurant } from './restaurant.js';

export interface Env {
  RESTAURANTS: DurableObjectNamespace<Restaurant>;
  /** One restaurant per visitor of the public demo, each with the demo evening of its own. */
  DEMO_RESTAURANTS: DurableObjectNamespace<DemoRestaurant>;
  /** What the public demo has spent, today and this month, and how many restaurants each visitor opened today. */
  DEMO_BUDGET: DurableObjectNamespace<DemoBudget>;
  /**
   * "eu" keeps every restaurant's data in the European Union. Only local runs
   * set "none", because workerd cannot pin data to a jurisdiction; any other
   * value leaves the restaurant routes unconfigured rather than unpinned.
   */
  DATA_JURISDICTION: string;
  /** OpenRouter id of the model the assistant uses, chosen with the evaluation. */
  MODEL: string;
  /** Comma-separated restaurant ids this deployment serves. Any other id is "not found". */
  RESTAURANT_IDS: string;
  /** The public demo's spending limits in dollars, a day and a month. Missing or unreadable keeps the demo paused. */
  DEMO_DAILY_USD: string;
  DEMO_MONTHLY_USD: string;
  /** Demo restaurants one visitor may open in a day. */
  DEMO_SANDBOXES_PER_IP: string;
  /** Messages one demo restaurant takes in its whole life. */
  DEMO_MESSAGES_PER_SANDBOX: string;
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
