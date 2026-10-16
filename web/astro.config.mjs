import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import preact from '@astrojs/preact';
import { defineConfig, envField } from 'astro/config';

const repository = fileURLToPath(new URL('..', import.meta.url));
const core = (entry) => fileURLToPath(new URL(`../src/${entry}`, import.meta.url));
// The one script written inline in the layout, read from its file so its hash in the policy never falls behind.
const barHeight = readFileSync(new URL('./src/lib/bar-height.js', import.meta.url), 'utf8');

export default defineConfig({
  // Where the site is published: each page names its canonical address and its other languages from it.
  site: 'https://maitre.live',
  output: 'static',
  // The dev server is also where the demo gets shown: no toolbar over the product.
  devToolbar: { enabled: false },
  // en/404.html and es/404.html next to their pages: the static assets serve the nearest 404 page.
  build: { format: 'preserve' },
  integrations: [preact()],
  security: {
    // Each page carries its policy in a <meta>, with the hashes of the scripts and styles Astro writes
    // inline. What a <meta> cannot carry, frame-ancestors among it, is in public/_headers.
    csp: {
      // Cloudflare Turnstile checks that a person is there before the live demo opens a restaurant for them:
      // its script, and the frame it may show, come from Cloudflare. A call to the restaurant goes through
      // LiveKit Cloud, whose project is the Worker's secret: any of its hosts, never a named one.
      directives: [
        "default-src 'self'",
        // The tab's icon is written into each page as a data: image, so Edge has it before any fetch. Firefox holds a
        // favicon to img-src: without data: here it refuses the icon and logs it on every page. An image runs no script.
        "img-src 'self' data:",
        "media-src 'self'",
        'frame-src https://challenges.cloudflare.com',
        "connect-src 'self' wss://*.livekit.cloud https://*.livekit.cloud",
      ],
      scriptDirective: {
        resources: ["'self'", 'https://challenges.cloudflare.com'],
        hashes: [`sha256-${createHash('sha256').update(barHeight).digest('base64')}`],
      },
      styleDirective: {
        // No inline style at all. The plan, the charts and the tour place things from script, through the
        // CSSOM, which the policy does not govern; no page is rendered with a style attribute.
        resources: ["'self'"],
      },
    },
  },
  env: {
    schema: {
      // Turnstile's site key, public by design. Without it the build has no live demo: the chat plays the recordings.
      PUBLIC_TURNSTILE_SITE_KEY: envField.string({ context: 'client', access: 'public', optional: true }),
    },
  },
  i18n: {
    locales: ['fr', 'en', 'es'],
    defaultLocale: 'fr',
    routing: { prefixDefaultLocale: false },
  },
  vite: {
    // No file inlined as a data: address: the policy takes fonts and media from the site only. The tab's icon is
    // written into the page on purpose (Base.astro), and img-src allows it.
    build: { assetsInlineLimit: 0 },
    resolve: {
      // The engine is used from source, as the Worker does: the browser runs the same code the tests check.
      alias: [
        { find: /^maitre\/demo$/, replacement: core('demo/index.ts') },
        // Loaded on demand: the panel plays a recording only when the chat booked something.
        { find: /^maitre\/demo\/chat$/, replacement: core('demo/chat.ts') },
        { find: /^maitre$/, replacement: core('index.ts') },
      ],
    },
    // Loaded on «Appeler» only: bundled when the dev server starts, so it is not discovered in the middle of a call.
    optimizeDeps: { include: ['livekit-client'] },
    server: {
      fs: { allow: [repository] },
      // The live demo's API is the Worker's: on astro dev and astro preview (which takes the same proxy) it goes to
      // wrangler dev, so every local address runs the real assistant.
      proxy: {
        '/v1': 'http://127.0.0.1:8787',
      },
    },
  },
});
