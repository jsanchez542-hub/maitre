import type { Env as MaitreEnv } from '../src/env.js';

// `env` from cloudflare:test carries the Worker's own bindings.
declare global {
  namespace Cloudflare {
    interface Env extends MaitreEnv {}
  }
}
