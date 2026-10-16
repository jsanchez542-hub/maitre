import type { Env } from './env.js';

/**
 * The demo's films are files of the site (web/public/media/), and the platform serves a file whole,
 * whatever Range it is asked for. Safari plays no video without ranges, so the Worker answers them:
 * it takes the film from the site's files and cuts out the bytes asked for. A film is a few
 * megabytes, and its name carries its version, so the file under a name never changes.
 */

/** The one kind of range a video player asks for: bytes=first-last, bytes=first- or bytes=-length. */
const ONE_RANGE = /^bytes=(\d*)-(\d*)$/;

export interface ByteRange {
  first: number;
  last: number;
}

/**
 * The bytes a Range header asks for in a file of `size` bytes: undefined when the header is not one
 * valid byte range, which the whole file answers, and null when the range lies outside the file.
 */
export function byteRange(header: string, size: number): ByteRange | null | undefined {
  const match = ONE_RANGE.exec(header.trim());
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '') {
    if (last === '') return undefined;
    const length = Number(last);
    return length === 0 || size === 0 ? null : { first: Math.max(0, size - length), last: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return undefined;
  if (start >= size) return null;
  return { first: start, last: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}

/** Whether an If-Range names the film as it is now. Only a strong ETag can say so, and a date never does. */
function sameFilm(ifRange: string | null, etag: string | null): boolean {
  return ifRange === null || (etag !== null && !etag.startsWith('W/') && ifRange.trim() === etag);
}

export async function serveFilm(request: Request, env: Env): Promise<Response> {
  // The site's files are asked for the whole film; a conditional request still gets its 304 from them.
  const asked = new Headers(request.headers);
  asked.delete('range');
  asked.delete('if-range');
  const file = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: asked }));
  if (file.status !== 200) return file;

  const range = request.method === 'GET' ? request.headers.get('range') : null;
  if (range === null || !sameFilm(request.headers.get('if-range'), file.headers.get('etag'))) {
    const whole = new Response(file.body, file);
    whole.headers.set('accept-ranges', 'bytes');
    return whole;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const part = byteRange(range, bytes.byteLength);
  const headers = new Headers(file.headers);
  headers.set('accept-ranges', 'bytes');
  // The runtime writes the length of what is sent.
  headers.delete('content-length');
  if (part === undefined) return new Response(bytes, { status: 200, headers });
  if (part === null) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.byteLength}`, 'accept-ranges': 'bytes' } });
  }
  headers.set('content-range', `bytes ${part.first}-${part.last}/${bytes.byteLength}`);
  return new Response(bytes.subarray(part.first, part.last + 1), { status: 206, headers });
}
