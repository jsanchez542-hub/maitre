import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, the Workers runtime, with a real Durable Object and its SQLite database.
// The network is cut off and the model key is a fake one, whatever .dev.vars holds: the tests
// answer for OpenRouter themselves, so no test can reach a paid API. The demo's limits are the
// ones wrangler.jsonc gives production, here too, even when .dev.vars raises them to try the
// demo by hand.
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
          DEMO_OPENROUTER_API_KEY: 'test-demo-openrouter-key',
          TURNSTILE_SECRET: 'test-turnstile-secret',
          LIVEKIT_URL: 'wss://maitre-test.livekit.cloud',
          LIVEKIT_API_KEY: 'test-livekit-key',
          LIVEKIT_API_SECRET: 'test-livekit-secret',
          DEMO_DAILY_USD: '1',
          DEMO_MONTHLY_USD: '10',
          DEMO_SANDBOXES_PER_IP: '5',
          DEMO_MESSAGES_PER_SANDBOX: '60',
          DEMO_CALLS_PER_SANDBOX: '3',
          DEMO_CALL_SECONDS: '240',
          DEMO_VOICE_USD_PER_MINUTE: '0.03',
        },
        outboundService: () => new Response('The network is off in tests.', { status: 503 }),
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
