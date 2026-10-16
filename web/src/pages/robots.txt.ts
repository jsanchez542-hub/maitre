import type { APIRoute } from 'astro';

// The panel stays crawlable on purpose: it answers with noindex, by header and by meta, which a crawler kept out by
// robots.txt would never read.
export const GET: APIRoute = ({ site }) =>
  new Response(['User-agent: *', 'Allow: /', '', `Sitemap: ${new URL('/sitemap.xml', site).href}`, ''].join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
