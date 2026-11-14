/** Small HTTP helpers for the Worker: JSON answers, bounded bodies, constant-time secrets. */

const MAX_BODY_BYTES = 16 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}

export function problem(status: number, code: string): Response {
  return json({ error: code }, status);
}

/** A stream of JSON lines: the phone line reads the first one and starts speaking before the last one is written. */
export function jsonLines(events: ReadableStream<Uint8Array>): Response {
  return new Response(events, { status: 200, headers: { ...SECURITY_HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8' } });
}

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** The request body as a JSON object, refusing anything larger than 16 KB without reading past that. */
export async function readJson(request: Request): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return { ok: false, response: problem(413, 'body_too_large') };
  const text = await readBounded(request);
  if (text === undefined) return { ok: false, response: problem(413, 'body_too_large') };
  // No body is an empty object: "seat them" needs no table when the plan already has one.
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, response: problem(400, 'body_must_be_an_object') };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: problem(400, 'body_is_not_json') };
  }
}

/** The body as text, or undefined once it passes the limit: a chunked body has no Content-Length to check. */
async function readBounded(request: Request): Promise<string | undefined> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The longest address read: an IPv6 address that ends in an IPv4 one takes 45 characters. */
const MAX_ADDRESS_CHARS = 45;
const HEXTET = /^[0-9a-f]{1,4}$/;

/**
 * A visitor's address as the limits count it. An IPv4 address counts whole. An
 * IPv6 address counts by its first 64 bits: a home or a phone is given that
 * whole block, and could take another of its addresses for every request and
 * never meet a limit. Anything that is not read as an address counts as it is.
 */
export function visitorBlock(address: string): string {
  const text = address.slice(0, MAX_ADDRESS_CHARS).toLowerCase();
  // An IPv4 visitor written the IPv6 way.
  if (text.startsWith('::ffff:') && text.includes('.')) return text.slice('::ffff:'.length);
  if (!text.includes(':') || text.includes('.')) return text;
  const halves = text.split('::');
  if (halves.length > 2) return text;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  // "::" stands for the groups left out, one at least; without it all eight are written.
  const leftOut = 8 - head.length - tail.length;
  if (halves.length === 2 ? leftOut < 1 : leftOut !== 0) return text;
  const groups = [...head, ...Array<string>(leftOut).fill('0'), ...tail];
  if (!groups.every((group) => HEXTET.test(group))) return text;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Compares a bearer token with the expected secret in constant time. Both are
 * hashed first, so their lengths cannot leak through the comparison either.
 */
export async function hasBearer(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const encoder = new TextEncoder();
  const [given, wanted] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(given, wanted);
}
