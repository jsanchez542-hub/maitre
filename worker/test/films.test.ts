import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { byteRange, serveFilm } from '../src/films.js';

const FILM_URL = 'https://maitre.test/media/merrain-v1-1000k.mp4';
const FILM = new Uint8Array(Array.from({ length: 1000 }, (_, index) => index % 256));
const ETAG = '"merrain-v1"';

/** The site's files as the platform serves them: the whole film, whatever Range it was sent. */
function site(): { env: Env; asked: Request[] } {
  const asked: Request[] = [];
  const assets = {
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      asked.push(request);
      if (new URL(request.url).pathname !== '/media/merrain-v1-1000k.mp4') return Promise.resolve(new Response('Not found', { status: 404 }));
      if (request.headers.get('if-none-match') === ETAG) return Promise.resolve(new Response(null, { status: 304, headers: { etag: ETAG } }));
      const headers = { 'content-type': 'video/mp4', etag: ETAG, 'cache-control': 'public, max-age=31536000, immutable' };
      return Promise.resolve(new Response(request.method === 'HEAD' ? null : FILM, { headers }));
    },
  };
  return { env: { ASSETS: assets } as unknown as Env, asked };
}

function film(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(FILM_URL, { method, headers });
}

describe('the demo’s films', () => {
  it('answers the first bytes Safari asks for before it plays anything', async () => {
    const { env, asked } = site();
    const response = await serveFilm(film({ range: 'bytes=0-1' }), env);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/1000');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1]);
    // The site's files are asked for the whole film.
    expect(asked[0]?.headers.has('range')).toBe(false);
  });

  it('answers a range to the end, the last bytes, and a range that runs past the end', async () => {
    const { env } = site();
    const tail = await serveFilm(film({ range: 'bytes=990-' }), env);
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect((await tail.arrayBuffer()).byteLength).toBe(10);

    const last = await serveFilm(film({ range: 'bytes=-10' }), env);
    expect(last.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect([...new Uint8Array(await last.arrayBuffer())]).toEqual([...FILM.subarray(990)]);

    const past = await serveFilm(film({ range: 'bytes=500-5000' }), env);
    expect(past.headers.get('content-range')).toBe('bytes 500-999/1000');
    expect((await past.arrayBuffer()).byteLength).toBe(500);
  });

  it('refuses a range outside the film and says how long the film is', async () => {
    const { env } = site();
    for (const range of ['bytes=1000-1001', 'bytes=-0']) {
      const response = await serveFilm(film({ range }), env);
      expect(response.status, range).toBe(416);
      expect(response.headers.get('content-range'), range).toBe('bytes */1000');
    }
  });

  it('sends the whole film for no range, several ranges, a range backwards, another unit or a film that has changed', async () => {
    const { env } = site();
    const asks = [{}, { range: 'bytes=0-1,5-6' }, { range: 'bytes=20-10' }, { range: 'items=0-1' }, { range: 'bytes=0-1', 'if-range': '"merrain-v0"' }];
    for (const headers of asks) {
      const response = await serveFilm(film(headers), env);
      expect(response.status, JSON.stringify(headers)).toBe(200);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILM);
    }
    const unchanged = await serveFilm(film({ range: 'bytes=0-1', 'if-range': ETAG }), env);
    expect(unchanged.status).toBe(206);
    await unchanged.arrayBuffer();
  });

  it('passes on what the site’s files answer: a copy still good, an unknown name, a HEAD', async () => {
    const { env } = site();
    expect((await serveFilm(film({ 'if-none-match': ETAG, range: 'bytes=0-1' }), env)).status).toBe(304);
    expect((await serveFilm(new Request('https://maitre.test/media/nothing-here.mp4'), env)).status).toBe(404);
    const head = await serveFilm(film({ range: 'bytes=0-1' }, 'HEAD'), env);
    expect(head.status).toBe(200);
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.body).toBeNull();
  });

  it('reads a range header the way the specification does', () => {
    expect(byteRange('bytes=0-0', 1)).toEqual({ first: 0, last: 0 });
    expect(byteRange(' bytes=2-4 ', 10)).toEqual({ first: 2, last: 4 });
    expect(byteRange('bytes=-20', 10)).toEqual({ first: 0, last: 9 });
    expect(byteRange('bytes=-', 10)).toBeUndefined();
    expect(byteRange('bytes=0-1', 0)).toBeNull();
  });
});
