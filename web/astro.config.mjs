import { fileURLToPath } from 'node:url';
import preact from '@astrojs/preact';
import { defineConfig } from 'astro/config';

const repository = fileURLToPath(new URL('..', import.meta.url));
const core = (entry) => fileURLToPath(new URL(`../src/${entry}`, import.meta.url));

export default defineConfig({
  output: 'static',
  // en/404.html and es/404.html next to their pages: the static assets serve the nearest 404 page.
  build: { format: 'preserve' },
  integrations: [preact()],
  security: {
    // Each page carries its policy in a <meta>, with the hashes of the scripts and styles Astro writes
    // inline. What a <meta> cannot carry, frame-ancestors among it, is in public/_headers.
    csp: {
      directives: ["default-src 'self'"],
      styleDirective: {
        // The plan places each table with a style attribute, from the restaurant's floor. No visitor's
        // text reaches the page as HTML, and Preact escapes everything it renders.
        resources: ["'self'", { resource: "'unsafe-inline'", kind: 'attribute' }],
      },
    },
  },
  i18n: {
    locales: ['fr', 'en', 'es'],
    defaultLocale: 'fr',
    routing: { prefixDefaultLocale: false },
  },
  vite: {
    resolve: {
      // The engine is used from source, as the Worker does: the browser runs the same code the tests check.
      alias: [
        { find: /^maitre\/demo$/, replacement: core('demo/index.ts') },
        { find: /^maitre$/, replacement: core('index.ts') },
      ],
    },
    server: { fs: { allow: [repository] } },
  },
});
