import type { Env } from './env.js';

/**
 * The demo's films and their posters, kept in R2 and served by the Worker from
 * the site's own origin: no binary in git, and no third party between the
 * visitor and the page. Names carry a version (merrain-v1-2000k.webm), so a
 * file never changes under its name and browsers may keep it for a year.
 *
 * Range requests are answered, because Safari will not play a video without
 * them, and a repeat visit gets 304 Not Modified from its ETag.
 */

/** Only these names exist: no listing, no path, no other kind of file. */
export const MEDIA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:mp4|webm|jpg|webp|avif)$/;

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

function baseHeaders(object: R2Object, name: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream');
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cross-origin-resource-policy', 'same-origin');
  return headers;
}

export async function serveMedia(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  if (!MEDIA_NAME.test(name) || !env.MEDIA) return new Response('Not found', { status: 404 });

  if (request.method === 'HEAD') {
    const object = await env.MEDIA.head(name);
    if (!object) return new Response(null, { status: 404 });
    const headers = baseHeaders(object, name);
    headers.set('content-length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  // R2 reads the Range and If-None-Match headers itself.
  const object = await env.MEDIA.get(name, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });
  const headers = baseHeaders(object, name);
  if (!('body' in object)) return new Response(null, { status: 304, headers });

  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has('range')) {
    const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix !== undefined ? range.suffix : (range.length ?? object.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}
