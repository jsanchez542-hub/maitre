import type { APIRoute } from 'astro';
import { LANGUAGES } from 'maitre';
import { HOME, LEGAL } from '../i18n/routes';

/** The pages a search engine should find, the restaurant's site and its legal page, each with its other languages. */
export const GET: APIRoute = ({ site }) => {
  const address = (path: string) => new URL(path, site).href;
  const entries = [HOME, LEGAL].flatMap((page) =>
    LANGUAGES.map((language) =>
      [
        '  <url>',
        `    <loc>${address(page[language])}</loc>`,
        ...LANGUAGES.map((code) => `    <xhtml:link rel="alternate" hreflang="${code}" href="${address(page[code])}"/>`),
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${address(page.fr)}"/>`,
        '  </url>',
      ].join('\n'),
    ),
  );
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
