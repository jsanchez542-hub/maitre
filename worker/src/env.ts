import type { Restaurant } from './restaurant.js';

export interface Env {
  RESTAURANTS: DurableObjectNamespace<Restaurant>;
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
  /** Secrets. Without them the routes that need them answer 503 rather than run open. */
  OPENROUTER_API_KEY?: string;
  /** For the services that talk on the guest's behalf: the web chat backend and the voice agent. */
  AGENT_TOKEN?: string;
  /** For the restaurant's dashboard. */
  STAFF_TOKEN?: string;
}

/** The Durable Object of one restaurant, or undefined when the deployment does not say where data may live. */
export function restaurantStub(env: Env, restaurantId: string): DurableObjectStub<Restaurant> | undefined {
  const namespace =
    env.DATA_JURISDICTION === 'eu' ? env.RESTAURANTS.jurisdiction('eu') : env.DATA_JURISDICTION === 'none' ? env.RESTAURANTS : undefined;
  return namespace?.get(namespace.idFromName(restaurantId));
}
