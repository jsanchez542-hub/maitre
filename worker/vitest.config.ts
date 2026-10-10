import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, the Workers runtime, with a real Durable Object and its SQLite database.
// The network is cut off and the model key is a fake one, whatever .dev.vars holds: the tests
// answer for OpenRouter themselves, so no test can reach a paid API.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          DATA_JURISDICTION: 'none',
          AGENT_TOKEN: 'test-agent-token',
          STAFF_TOKEN: 'test-staff-token',
          OPENROUTER_API_KEY: 'test-openrouter-key',
        },
        outboundService: () => new Response('The network is off in tests.', { status: 503 }),
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
