import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const PAGES = join(WEB, 'src/pages');

interface Rule {
  path: string;
  headers: Map<string, string>;
}

/** public/_headers in Cloudflare's format: a path on its own line, then its headers indented under it. */
function rules(): Rule[] {
  const found: Rule[] = [];
  for (const line of readFileSync(join(WEB, 'public/_headers'), 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    if (line === text) {
      found.push({ path: text, headers: new Map() });
    } else if (!text.startsWith('!')) {
      const colon = text.indexOf(':');
      found.at(-1)!.headers.set(text.slice(0, colon).trim().toLowerCase(), text.slice(colon + 1).trim());
    }
  }
  return found;
}

/** A rule's path is exact, or ends in a * that takes the rest. */
const matches = (rule: string, path: string): boolean => (rule.endsWith('*') ? path.startsWith(rule.slice(0, -1)) : rule === path);

/** Every page the site builds, and whether it offers the call to the restaurant (SitePage carries it). */
function pages(dir = PAGES): { route: string; calls: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return pages(join(dir, entry.name));
    if (entry.name !== 'index.astro') return [];
    const folder = relative(PAGES, dir).split(sep).join('/');
    return [{ route: folder === '' ? '/' : `/${folder}/`, calls: readFileSync(join(dir, entry.name), 'utf8').includes('SitePage') }];
  });
}

const policies = (route: string): Rule[] => rules().filter((rule) => matches(rule.path, route) && rule.headers.has('permissions-policy'));

describe('the headers Cloudflare sends with the pages', () => {
  it('uses only paths the matching above reads: exact, or ending in one *', () => {
    for (const { path } of rules()) expect(path).toMatch(/^\/[^*]*\*?$/);
  });

  it('gives each page its Permissions-Policy from one rule, so the order Cloudflare applies them in cannot matter', () => {
    for (const { route } of pages()) expect(policies(route).map((rule) => rule.path), route).toHaveLength(1);
  });

  it('opens the microphone on the pages that call the restaurant, and on no other', () => {
    expect(pages().filter((page) => page.calls).map((page) => page.route).sort()).toEqual(['/', '/en/', '/es/']);
    for (const { route, calls } of pages()) {
      expect(policies(route)[0]?.headers.get('permissions-policy'), route).toContain(calls ? 'microphone=(self)' : 'microphone=()');
    }
  });
});
