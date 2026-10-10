import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const HOMES = [
  { path: '/', lang: 'fr', heading: 'Un soir de service', list: 'Liste', walkIn: 'Client sur place' },
  { path: '/en/', lang: 'en', heading: 'One night of service', list: 'List', walkIn: 'Walk-in guest' },
  { path: '/es/', lang: 'es', heading: 'Una noche de servicio', list: 'Lista', walkIn: 'Cliente sin reserva' },
] as const;

const NOT_FOUND = [
  { path: '/404.html', lang: 'fr', heading: 'Cette page n’existe pas.' },
  { path: '/en/404.html', lang: 'en', heading: 'This page doesn’t exist.' },
  { path: '/es/404.html', lang: 'es', heading: 'Esta página no existe.' },
] as const;

/** Console errors and uncaught exceptions, collected for the whole test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Opens a page and waits until the service island is interactive. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('astro-island')).not.toHaveAttribute('ssr');
}

/** One directive of the page's content security policy, as its <meta> writes it. */
async function policy(page: Page, directive: string): Promise<string | undefined> {
  const content = (await page.locator('meta[http-equiv="content-security-policy"]').getAttribute('content')) ?? '';
  return content
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
}

async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

for (const home of HOMES) {
  test(`${home.path} shows the evening, in plan and in list, with nothing for axe to report`, async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, home.path);

    await expect(page.locator('html')).toHaveAttribute('lang', home.lang);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(home.heading);
    await expectAccessible(page);

    await page.getByRole('button', { name: home.list, exact: true }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Moreau' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: home.walkIn })).toBeVisible();
    await expectAccessible(page);

    expect(errors).toEqual([]);
  });
}

test('every page runs under a policy that allows only its own scripts, by hash', async ({ page }) => {
  for (const path of [...HOMES, ...NOT_FOUND].map((entry) => entry.path)) {
    await page.goto(path);
    const scripts = await policy(page, 'script-src');
    expect(scripts).toMatch(/^script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+$/);
    expect(await policy(page, 'style-src')).not.toContain('unsafe');
    expect(await policy(page, 'default-src')).toBe("default-src 'self'");
  }
});

for (const notFound of NOT_FOUND) {
  test(`${notFound.path} is translated, with nothing for axe to report`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(notFound.path);
    await expect(page.locator('html')).toHaveAttribute('lang', notFound.lang);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(notFound.heading);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });
}

test('an unknown address answers 404 with the French page', async ({ page }) => {
  const response = await page.goto('/carte-des-vins');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cette page n’existe pas.');
});

test.describe('the staff at work, on the French page', () => {
  test('seat a party waiting at the door', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/');

    await page.getByRole('button', { name: /^Table 8,/ }).click();
    await expect(page.getByRole('heading', { level: 3 })).toHaveText('Table 8 · Moreau · 4 couverts');
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Installer à la table 8' }).click();
    await expect(page.getByRole('status')).toHaveText('Moreau · À table');
    await expect(page.getByRole('button', { name: /^Table 8,/ })).toHaveClass(/is-seated/);
    await expect(page.getByRole('heading', { level: 3 })).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('seat a walk-in at a table booked later, and let the engine move that booking', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/');

    await page.getByRole('button', { name: /^Table 4,/ }).click();
    await expect(page.getByRole('heading', { level: 3 })).toHaveText('Table 4 · Libre');
    await expect(page.getByRole('group', { name: 'Ensuite\u202F: Roux à 20:30' })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: '2 personnes' }).click();
    await expect(page.getByRole('status')).toHaveText('Client sur place · À table');
    await expect(page.getByRole('button', { name: /^Table 4,/ })).toHaveClass(/is-seated/);
    await expect(page.getByRole('button', { name: /^Table [56], .*Roux à 20:30/ })).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('mark a party that arrives ahead of its time', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('button', { name: /^Table 9,/ }).click();
    await page.getByRole('group', { name: 'Ensuite\u202F: Bernard à 20:15' }).getByRole('button', { name: 'Marquer l’arrivée' }).click();
    await expect(page.getByRole('status')).toHaveText('Bernard · Arrivée');
    await expect(page.getByRole('button', { name: /^Table 9,/ })).toHaveClass(/is-arrived/);
    await expect(page.getByRole('button', { name: 'Installer à la table 9' })).toBeVisible();
  });

  test('never show a whole phone number', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('button', { name: /^Table 1,/ }).click();
    await expect(page.getByText('+33 6 •• •• •• 10')).toBeVisible();
    await expect(page.getByText('+33 6 00 00 00 10')).toHaveCount(0);
  });

  test('move the clock on, and the table held for a guest booking online is let go', async ({ page }) => {
    await open(page, '/');
    await expect(page.getByText('1 en cours')).toBeVisible();
    await page.getByRole('button', { name: '+15 min' }).click();
    await expect(page.getByText('il est 20:20')).toBeVisible();
    await expect(page.getByText('0 en cours')).toBeVisible();
  });
});
