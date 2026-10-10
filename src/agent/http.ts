import { ModelError, type ModelErrorKind } from './model.js';

/**
 * The few web APIs the providers need, read from globalThis with structural
 * types. Node, browsers and Cloudflare Workers all have them, and declaring
 * them here keeps the core free of DOM or Node type definitions.
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: unknown;
}

export type Fetch = (url: string, init: HttpRequest) => Promise<HttpResponse>;

interface WebGlobals {
  fetch?: Fetch;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  AbortController?: new () => { signal: unknown; abort(): void };
}

const web = globalThis as unknown as WebGlobals;

/** The runtime's fetch, bound: Workers throw "Illegal invocation" on an unbound one. */
export function runtimeFetch(): Fetch {
  if (!web.fetch) throw new Error('fetch is not available in this runtime');
  return web.fetch.bind(globalThis);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (!web.setTimeout) throw new Error('setTimeout is not available in this runtime');
    web.setTimeout(resolve, ms);
  });
}

/** POSTs JSON and gives the parsed answer, or a ModelError that is safe to log. */
export async function postJson(
  fetch: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  classify: (status: number, body: string) => ModelErrorKind,
): Promise<unknown> {
  const controller = web.AbortController ? new web.AbortController() : undefined;
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = web.setTimeout?.(() => {
      controller?.abort();
      reject(new ModelError('timeout', `No answer after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  let response: HttpResponse;
  try {
    response = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      }),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw new ModelError('network', 'The provider could not be reached');
  } finally {
    web.clearTimeout?.(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ModelError(
      classify(response.status, text),
      `Provider answered ${response.status}: ${errorSummary(text)}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelError('invalid_response', 'The provider answered with something that is not JSON');
  }
}

/** The provider's own error message, short, without echoing the whole body. */
function errorSummary(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string') return message.slice(0, 200);
  } catch {
    // Not JSON: fall through to the generic text.
  }
  return 'no details';
}

/**
 * Retries what is worth retrying (timeouts, rate limits, overload, server errors)
 * with short waits: a guest is on the line, so waiting long is a failure too.
 */
export async function withRetries<T>(attempt: () => Promise<T>, maxRetries: number, baseDelayMs = 400): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ModelError) || !error.retryable || retry >= maxRetries) throw error;
      const asked = error.retryAfter === undefined ? 0 : error.retryAfter * 1000;
      await sleep(Math.min(Math.max(asked, baseDelayMs * 2 ** retry), 4000));
    }
  }
}
