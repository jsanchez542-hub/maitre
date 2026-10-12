import { env, reset, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

const MEDIA = 'https://maitre.test/media';
const FILM = new Uint8Array(Array.from({ length: 1000 }, (_, index) => index % 256));

afterEach(async () => {
  await reset();
});

async function store(): Promise<void> {
  if (!env.MEDIA) throw new Error('the test config must bind MEDIA');
  await env.MEDIA.put('merrain-v1-1000k.webm', FILM, { httpMetadata: { contentType: 'video/webm' } });
}

describe('the demo’s films', () => {
  it('serves a whole film from the site’s origin, to be kept for a year', async () => {
    await store();
    const response = await SELF.fetch(`${MEDIA}/merrain-v1-1000k.webm`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/webm');
    expect(response.headers.get('content-length')).toBe('1000');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILM);
  });

  it('answers a range, as Safari asks for before it plays anything', async () => {
    await store();
    const start = await SELF.fetch(`${MEDIA}/merrain-v1-1000k.webm`, { headers: { range: 'bytes=0-1' } });
    expect(start.status).toBe(206);
    expect(start.headers.get('content-range')).toBe('bytes 0-1/1000');
    expect([...new Uint8Array(await start.arrayBuffer())]).toEqual([0, 1]);

    const end = await SELF.fetch(`${MEDIA}/merrain-v1-1000k.webm`, { headers: { range: 'bytes=-10' } });
    expect(end.status).toBe(206);
    expect(end.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(end.headers.get('content-length')).toBe('10');
    await end.arrayBuffer();
  });

  it('tells a returning browser its copy is still good, and answers HEAD without the film', async () => {
    await store();
    const first = await SELF.fetch(`${MEDIA}/merrain-v1-1000k.webm`);
    await first.arrayBuffer();
    const again = await SELF.fetch(`${MEDIA}/merrain-v1-1000k.webm`, { headers: { 'if-none-match': first.headers.get('etag') ?? '' } });
    expect(again.status).toBe(304);
    const head = await SELF.fetch(`${MEDIA}/merrain-v1-1000k.webm`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('1000');
  });

  it('knows no other name, no path and no other method', async () => {
    await store();
    for (const name of ['nothing-here.webm', 'merrain-v1-1000k.exe', '..%2Fwrangler.jsonc', 'MERRAIN.webm']) {
      expect((await SELF.fetch(`${MEDIA}/${name}`)).status, name).toBe(404);
    }
    expect((await SELF.fetch(`${MEDIA}/merrain-v1-1000k.webm`, { method: 'PUT', body: 'x' })).status).toBe(405);
  });
});
