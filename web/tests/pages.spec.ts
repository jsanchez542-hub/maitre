import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ALLERGENS, allergenStatus, messages, type AllergenAnswer, type Dish } from '../../src/index.js';
import { FakeDemo } from './fake-demo';

const SITES = [
  {
    path: '/',
    lang: 'fr',
    book: 'Réserver',
    clock: /^Bordeaux, vendredi 20\sh\s05$/,
    notice: /^N’écrivez aucune donnée réelle\s: tout est effacé au bout de 24\sh\.$/,
    // At 20:05 tonight's 20:30 is past its hour's notice: the restaurant suggests tomorrow's.
    chip: 'Une table demain soir',
    example: /^Avez-vous une table pour 2 demain soir à 20\sh\s30\s\?$/,
    message: 'Votre message',
    name: 'Au nom de Lemoine',
    guest: 'Lemoine',
    phone: 'Votre numéro de téléphone',
    number: '06 39 98 00 21',
    sent: 'Numéro envoyé',
    booked: 'Réservation confirmée',
    panel: 'Voir côté restaurant',
    via: 'sur le site',
  },
  {
    path: '/en/',
    lang: 'en',
    book: 'Book a table',
    clock: /^Bordeaux, Friday 8:05\spm$/,
    notice: /^Don’t enter any real details: everything is deleted after 24\shours\.$/,
    chip: 'A table tomorrow evening',
    example: /^Do you have a table for 2 tomorrow evening at 8:30\spm\?$/,
    message: 'Your message',
    name: 'Clarke',
    guest: 'Clarke',
    phone: 'Your phone number',
    number: '+44 7700 900123',
    sent: 'Number sent',
    booked: 'Booking confirmed',
    panel: 'See the restaurant side',
    via: 'on the website',
  },
  {
    path: '/es/',
    lang: 'es',
    book: 'Reservar',
    clock: /^Burdeos, viernes 20:05$/,
    notice: /^No escriba datos reales: todo se borra al cabo de 24\shoras\.$/,
    chip: 'Mesa mañana por la noche',
    example: /^¿Tienen mesa para 2 mañana por la noche a las 20:30\?$/,
    message: 'Su mensaje',
    name: 'A nombre de Navarro',
    guest: 'Navarro',
    phone: 'Su número de teléfono',
    number: '+33 6 39 98 00 22',
    sent: 'Número enviado',
    booked: 'Reserva confirmada',
    panel: 'Ver el lado del restaurante',
    via: 'en la web',
  },
] as const;

const PANELS = [
  { path: '/panel/', lang: 'fr', heading: 'Salle de Merrain', plan: 'Plan', walkIn: 'Client sur place' },
  { path: '/en/panel/', lang: 'en', heading: 'Merrain’s floor', plan: 'Floor plan', walkIn: 'Guest at the door' },
  { path: '/es/panel/', lang: 'es', heading: 'Sala de Merrain', plan: 'Plano', walkIn: 'Cliente sin reserva' },
] as const;

const LEGALS = [
  { path: '/mentions-legales/', lang: 'fr', heading: 'Mentions légales et confidentialité', call: 'L’appel au restaurant' },
  { path: '/en/legal/', lang: 'en', heading: 'Legal notice and privacy', call: 'The call to the restaurant' },
  { path: '/es/aviso-legal/', lang: 'es', heading: 'Aviso legal y privacidad', call: 'La llamada al restaurante' },
] as const;

const NOT_FOUND = [
  { path: '/404.html', lang: 'fr', heading: 'Cette page n’existe pas.' },
  { path: '/en/404.html', lang: 'en', heading: 'This page doesn’t exist.' },
  { path: '/es/404.html', lang: 'es', heading: 'Esta página no existe.' },
] as const;

let demo: FakeDemo;

test.beforeEach(async ({ page }) => {
  demo = new FakeDemo();
  await demo.install(page);
  // The first visit's tour has tests of its own: elsewhere the panel opens as for a visitor who has seen it.
  await page.addInitScript(() => localStorage.setItem('maitre.tour', 'done'));
});

/**
 * Console errors and uncaught exceptions, collected for the whole test. A test that makes the API fail on purpose
 * names that address: the browser reports the failed request itself, and that report is expected there.
 */
function watchErrors(page: Page, provoked?: RegExp): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (provoked?.test(message.location().url) && message.text().startsWith('Failed to load resource')) return;
    errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Opens a page and waits until its island is interactive. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('astro-island').first()).not.toHaveAttribute('ssr');
}

/** «Réserver» at the top opens the booking itself: the chat. */
async function openChat(page: Page): Promise<void> {
  await page.locator('.site__book').click();
}

/** The phone and the middle widths show the list or the plan; from 1180 px both stand side by side, with no switch. */
async function showPlan(page: Page, label = 'Plan'): Promise<void> {
  // The service, and its switch with it, shows once the panel knows which restaurant it shows.
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  const toggle = page.getByRole('button', { name: label, exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

/** A dish of the menu in Réglages, by its French name. */
function dish(page: Page, name: string) {
  return page.locator('.dish').filter({ has: page.locator('.dish__name', { hasText: name }) });
}

/** A dish's sheet as the menu should read it in French, from the engine's own answers. */
function sheetOf(entry: Dish): string[] {
  const words = messages('fr');
  const named = (answer: AllergenAnswer) => ALLERGENS.filter((allergen) => allergenStatus(entry, allergen) === answer).map((allergen) => words.allergen(allergen));
  const lines: string[] = [];
  if (named('contains').length > 0) lines.push(`●Contient : ${named('contains').join(', ')}`);
  if (named('may_contain').length > 0) lines.push(`○Traces éventuelles : ${named('may_contain').join(', ')}`);
  const unstated = named('unknown');
  if (unstated.length > 3) lines.push(`?Non renseigné (${unstated.length}) : ${unstated.slice(0, 3).join(', ')}… voir tous`);
  else if (unstated.length > 0) lines.push(`?Non renseigné : ${unstated.join(', ')}`);
  const free = named('free').length;
  if (free === ALLERGENS.length) return [`·Aucun des ${ALLERGENS.length} allergènes`];
  if (free > 0) lines.push(`·Ne contient pas : le reste des ${ALLERGENS.length}`);
  return lines;
}

/** The row of a booking in the list, as a button: a booking is opened from the list as well as from the plan. */
function row(page: Page, name: string) {
  return page.locator('.rows').getByRole('button', { name: new RegExp(name) });
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

/** WCAG contrast between the menu's lines and what shows around them, read from the screen's own pixels. */
async function linesContrast(page: Page): Promise<number> {
  const middle = await page.locator('.site__toggle .site__lines').boundingBox();
  if (!middle) throw new Error('The menu’s lines are not on the screen.');
  // The two lines fall on rows 12 and 19 of the capture; the rows between and around them are what the lines are
  // read against.
  const capture = await page.screenshot({ clip: { x: middle.x - 2, y: middle.y - 12, width: middle.width + 4, height: 26 }, scale: 'css' });
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], { type: 'image/png' }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data, width } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const around: number[] = [];
    for (const row of [5, 6, 7, 15, 16, 17, 23, 24]) {
      for (let column = 3; column < width - 3; column += 1) {
        const offset = (row * width + column) * 4;
        around.push(0.2126 * linear(data[offset]!) + 0.7152 * linear(data[offset + 1]!) + 0.0722 * linear(data[offset + 2]!));
      }
    }
    const background = around.reduce((sum, value) => sum + value, 0) / around.length;
    const ink = getComputedStyle(document.querySelector('.site__toggle .site__lines')!, '::before').backgroundColor;
    const [red = 0, green = 0, blue = 0] = (ink.match(/\d+/g) ?? []).map(Number);
    const line = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    return (Math.max(line, background) + 0.05) / (Math.min(line, background) + 0.05);
  }, capture.toString('base64'));
}

for (const site of SITES) {
  test(`${site.path} is Merrain’s own site, and its live chat books a table in the visitor’s own restaurant`, async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, site.path);

    await expect(page.locator('html')).toHaveAttribute('lang', site.lang);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Merrain');
    await expectAccessible(page);

    await expect(page.locator('.site__book')).toHaveText(site.book);
    await openChat(page);
    const chat = page.getByRole('dialog');
    await expect(chat).toBeVisible();
    // The restaurant's own day and time as a fact, as the call shows it, then what to know before writing.
    await expect(chat.locator('.chat__notice p')).toHaveText([site.clock, site.notice]);
    const field = chat.getByRole('textbox', { name: site.message });
    // A chip fills the field with its whole example, and the visitor sends it.
    await chat.getByRole('button', { name: site.chip, exact: true }).click();
    await expect(field).toHaveValue(site.example);
    await expectAccessible(page);
    await field.press('Enter');
    await expect(chat.locator('.chat__line--agent')).toHaveCount(2);
    await field.fill(site.name);
    await field.press('Enter');

    // The number goes in its own field, and the assistant answers it at once.
    const phone = chat.getByRole('textbox', { name: site.phone });
    await expect(phone).toBeFocused();
    await phone.fill(site.number);
    await expectAccessible(page);
    await phone.press('Enter');
    await expect(chat.getByText(site.booked, { exact: true })).toBeVisible();
    await expect(chat.getByText(site.sent)).toBeVisible();
    await expect(phone).toHaveCount(0);
    await expectAccessible(page);

    await chat.getByRole('link', { name: site.panel }).click();
    await expect(page).toHaveURL(new RegExp(`${site.lang === 'fr' ? '' : site.lang + '/'}panel/$`));
    await expect(page.getByRole('status')).toContainText(`${site.guest} ${site.via}`);
    // The message leaves the demo's bar in view, also on the phone, where the bar wraps to a height of its own.
    const bar = await page.locator('.demo-bar').boundingBox();
    const message = await page.locator('.toast').boundingBox();
    expect(message!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
    // The card of the booking's table, where it is marked new even when another party holds the table now.
    const card = page.getByRole('region', { name: /^(Table|Mesa) \d+/ });
    await expect(card).toContainText(site.guest);
    await expect(card.locator('.pill--new')).toBeVisible();
    await expectAccessible(page);
    // Closed, the card gives way to the list, where the booking is marked new too.
    await card.locator('.card__close').click();
    await expect(page.locator('.rows .pill--new').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('the live chat says it is live, scrolls as one conversation, and its examples step aside once the visitor writes', async ({ page }) => {
  const errors = watchErrors(page);
  // The answer takes a moment, as the model's does: long enough to see the assistant typing.
  await page.route('**/v1/demo/sandboxes/*/chat', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fallback();
  });
  await open(page, '/');
  await openChat(page);
  const chat = page.getByRole('dialog', { name: 'Réserver chez Merrain' });
  await expect(chat.locator('.chat__status')).toHaveText('L’assistant IA, en direct');
  // 20:05 at the restaurant: it greets as the evening asks.
  await expect(chat.locator('.chat__line--agent').first()).toHaveText(/^Bonsoir et bienvenue chez Merrain/);
  await expect(chat.locator('.chat__line--agent').first()).toBeInViewport({ ratio: 1 });

  // One scroll, the conversation's: no list of its own under it, and the input stays at the bottom.
  const scrolling = await chat.evaluate((dialog) =>
    [...dialog.querySelectorAll('*')]
      .filter((element) => element.tagName !== 'TEXTAREA' && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))
      .map((element) => element.className),
  );
  expect(scrolling).toEqual(['chat__log']);

  const chips = chat.getByRole('group', { name: 'Partir d’un exemple' }).getByRole('button');
  // A guest's two questions: no trick on the guest's side.
  await expect(chips).toHaveText(['Une table demain soir', 'Sans gluten ?']);
  const field = chat.getByRole('textbox', { name: 'Votre message' });
  await chips.nth(1).click();
  await expect(field).toHaveValue(/^Est-ce que le confit de canard contient du gluten/);
  await field.press('Enter');
  await expect(chat.getByRole('log').getByText('Merrain réfléchit…')).toBeVisible();
  await expect(chips).toHaveCount(0);
  await expect(chat.locator('.chat__line--agent')).toHaveCount(2);
  await expect(chat.getByText('Merrain réfléchit…')).toHaveCount(0);
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test('the chat greets by the restaurant’s hour, whatever the hour where the visitor is', async ({ page }) => {
  // Friday 16 at 10:00 in Bordeaux: «Bonjour», even where the tests run at night.
  demo = new FakeDemo(new Date('2026-10-16T08:00:00.000Z'));
  await demo.install(page);
  await open(page, '/');
  await openChat(page);
  await expect(page.getByRole('dialog').locator('.chat__line--agent').first()).toHaveText(/^Bonjour et bienvenue chez Merrain/);
});

test('the chat says what time it is at Merrain by the restaurant’s own clock, not the visitor’s', async ({ page }) => {
  await open(page, '/');
  await openChat(page);
  // The tests' restaurant lives on Friday 16 at 20:05, whatever the day the tests run.
  await expect(page.getByRole('dialog').locator('.chat__notice p').first()).toHaveText(/^Bordeaux, vendredi 20\sh\s0[56]$/);
});

test('when the demo is closed today, the chat opens on the recordings without opening a restaurant', async ({ page }) => {
  demo.status = { live: false, calls: null };
  const opened: string[] = [];
  page.on('request', (request) => {
    if (/\/v1\/demo\/sandboxes$/.test(request.url())) opened.push(request.url());
  });
  await open(page, '/');
  await openChat(page);
  const chat = page.getByRole('dialog');
  await expect(chat.locator('.chat__notice')).toHaveText(/^Le chat en direct n’est pas disponible pour le moment\./);
  await expect(chat.getByRole('group', { name: 'Choisissez une conversation enregistrée' })).toBeVisible();
  expect(opened).toEqual([]);
});

test('when the demo is closed today, the panel shows the demo evening and says it is not live', async ({ page }) => {
  demo.status = { live: false, calls: null };
  await open(page, '/panel/');
  await expect(page.getByRole('status').first()).toContainText('Le direct n’est pas disponible pour le moment');
  await expect(page.locator('.demo-bar__note')).toHaveText(/\(pas en direct\)$/);
});

test.describe('the call to the restaurant, from the browser', () => {
  test('is offered only when the demo takes calls', async ({ page }) => {
    demo.status = { live: true, calls: null };
    await open(page, '/');
    await page.waitForFunction(() => document.querySelector('astro-island[component-url*="RestaurantCall"]:not([ssr])'));
    await page.waitForTimeout(400);
    // One in the header beside «Réserver», one on the booking screen: neither shows when it would fail.
    await expect(page.locator('[data-call]')).toHaveCount(2);
    for (const trigger of await page.locator('[data-call]').all()) await expect(trigger).toBeHidden();
  });

  test('is in the header beside «Réserver», as a restaurant gives its number at the top', async ({ page }) => {
    await open(page, '/');
    const tabs = page.locator('.site__tabs > *');
    await expect(tabs.first()).toBeVisible();
    await expect(tabs).toHaveText(['Appeler', 'Réserver']);
    await tabs.first().click();
    const call = page.getByRole('dialog', { name: 'Appeler Merrain' });
    await expect(call).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(call).toBeHidden();
    await expect(tabs.first()).toBeFocused();
  });

  test('asks for the microphone on «Appeler», and spends no call when it is refused', async ({ page }) => {
    // The visitor says no, as a browser reports it.
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    const errors = watchErrors(page);
    await open(page, '/');
    const trigger = page.locator('#reserver [data-call]');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText('Appeler le restaurant');
    await trigger.click();
    const call = page.getByRole('dialog', { name: 'Appeler Merrain' });
    // A phone's call screen: the restaurant and its local time, «Appeler», and the terms once and small.
    await expect(call.getByRole('heading', { name: 'Merrain' })).toBeVisible();
    await expect(call.locator('.call__place')).toHaveText(/^Bordeaux, vendredi 20\sh\s05$/);
    await expect(call.locator('.call__status')).toHaveCount(0);
    await expect(call.getByRole('button', { name: 'Appeler', exact: true })).toBeFocused();
    await expect(call.locator('.call__terms')).toHaveText(/^Jusqu’à 4\smin par appel\. Votre voix n’est pas enregistrée\.$/);
    await expectAccessible(page);
    await call.getByRole('button', { name: 'Appeler', exact: true }).click();
    await expect(call.locator('.chat__problem')).toHaveText(/^Le micro est bloqué pour ce site\. Autorisez-le/);
    // The problem alone: no state above it, and the terms give it the room.
    await expect(call.locator('.call__status')).toHaveCount(0);
    await expect(call.locator('.call__terms')).toHaveCount(0);
    await expect(call.getByRole('button', { name: 'Appeler', exact: true })).toBeFocused();
    await expectAccessible(page);
    expect(demo.lines).toEqual([]);
    expect(errors).toEqual([]);
  });

  test.describe('with a microphone', () => {
    test.use({ permissions: ['microphone'] });

    test('asks for a line in the page’s language from the booking screen, and says so when the line cannot open', async ({ page }) => {
      // No room can be reached from a test: LiveKit's addresses answer nothing.
      await page.route(/livekit\.cloud/, (route) => route.abort());
      await page.routeWebSocket(/livekit\.cloud/, (socket) => socket.close());
      await open(page, '/es/');
      const trigger = page.locator('#reserver [data-call]');
      await expect(trigger).toHaveText('Llamar al restaurante');
      await trigger.click();
      const call = page.getByRole('dialog', { name: 'Llamar a Merrain' });
      await expect(call.locator('.call__place')).toHaveText('Burdeos, viernes 20:05');
      await call.getByRole('button', { name: 'Llamar', exact: true }).click();
      await expect(call.locator('.call__status')).toHaveText(/^(Llamando…|Está sonando…)$/);
      await expect(call.getByRole('button', { name: 'Colgar' })).toBeFocused();
      await expect(call.locator('.chat__problem')).toHaveText(/^No se pudo establecer la línea/, { timeout: 25_000 });
      await expect(call.locator('.call__status')).toHaveCount(0);
      await expect(call.getByRole('button', { name: 'Llamar', exact: true })).toBeFocused();
      expect(demo.lines).toEqual(['es']);
    });

    test('lets the caller choose the microphone once the browser has allowed one, and calls with that one', async ({ page }) => {
      await page.route(/livekit\.cloud/, (route) => route.abort());
      await page.routeWebSocket(/livekit\.cloud/, (socket) => socket.close());
      // A laptop whose default input is «Stereo Mix», which records the speakers and never the caller.
      await page.addInitScript(() => {
        const inputs = [
          { deviceId: 'default', label: 'Predeterminado - Stereo Mix (Realtek(R) Audio)' },
          { deviceId: 'communications', label: 'Comunicaciones - Microphone Array (Realtek(R) Audio)' },
          { deviceId: 'stereo-mix', label: 'Stereo Mix (Realtek(R) Audio)' },
          { deviceId: 'microphone-array', label: 'Microphone Array (Realtek(R) Audio)' },
        ];
        navigator.mediaDevices.enumerateDevices = async () =>
          inputs.map((input) => ({ ...input, kind: 'audioinput', groupId: input.deviceId, toJSON: () => input }) as MediaDeviceInfo);
        const asked: unknown[] = [];
        Object.assign(window, { asked });
        const allowed = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        // A copy: LiveKit writes the device it opened into its constraints afterwards.
        navigator.mediaDevices.getUserMedia = (constraints) => {
          asked.push(structuredClone(constraints?.audio));
          return allowed({ audio: true });
        };
      });
      await open(page, '/es/');
      await page.locator('#reserver [data-call]').click();
      const call = page.getByRole('dialog', { name: 'Llamar a Merrain' });
      const picker = call.getByRole('combobox', { name: 'Micrófono', exact: true });
      // Windows' second name for its communications microphone is left out.
      await expect(picker.locator('option')).toHaveText([
        'Predeterminado - Stereo Mix (Realtek(R) Audio)',
        'Stereo Mix (Realtek(R) Audio)',
        'Microphone Array (Realtek(R) Audio)',
      ]);
      await picker.selectOption({ label: 'Microphone Array (Realtek(R) Audio)' });
      await expectAccessible(page);
      await call.getByRole('button', { name: 'Llamar', exact: true }).click();
      await expect(call.locator('.chat__problem')).toHaveText(/^No se pudo establecer la línea/, { timeout: 25_000 });
      const asked = await page.evaluate(() => (window as unknown as { asked: unknown[] }).asked);
      expect(asked).toContainEqual(expect.objectContaining({ deviceId: { exact: 'microphone-array' } }));
    });

    test('says when the restaurant takes no calls now, stops offering them, and offers the chat instead', async ({ page }) => {
      demo.failNext.call = { status: 409, error: 'calls_unavailable' };
      await open(page, '/');
      await page.locator('#reserver [data-call]').click();
      const call = page.getByRole('dialog', { name: 'Appeler Merrain' });
      await call.getByRole('button', { name: 'Appeler', exact: true }).click();
      // Not the visitor's connection: the restaurant's line, said as such, and the written way to book in its place.
      await expect(call.locator('.chat__problem')).toHaveText(/^Les appels ne sont pas disponibles pour le moment\.\s*Vous pouvez réserver par écrit\.\s*Réserver$/);
      await expect(call.getByRole('button', { name: 'Appeler', exact: true })).toHaveCount(0);
      await expect(call.locator('.call__device')).toHaveCount(0);
      const book = call.getByRole('link', { name: 'Réserver', exact: true });
      await expect(book).toBeFocused();
      await expectAccessible(page);
      await expect(page.locator('[data-call]')).toHaveCount(2);
      for (const trigger of await page.locator('[data-call]').all()) await expect(trigger).toBeHidden();
      await book.click();
      await expect(call).toBeHidden();
      await expect(page.getByRole('dialog', { name: /^Réserver chez Merrain/ })).toBeVisible();
    });

    test('says when the restaurant has taken its calls, with a new restaurant to call instead', async ({ page }) => {
      demo.failNext.call = { status: 429, error: 'call_limit' };
      await open(page, '/');
      await page.locator('#reserver [data-call]').click();
      const call = page.getByRole('dialog', { name: 'Appeler Merrain' });
      await call.getByRole('button', { name: 'Appeler', exact: true }).click();
      await expect(call.locator('.chat__problem')).toHaveText(/^Vous avez déjà passé vos 3\sappels à ce restaurant\./);
      await expect(call.getByRole('button', { name: 'Ouvrir un nouveau restaurant' })).toBeVisible();
    });
  });
});

for (const [path, request, group, message] of [
  ['/', 'Faire une demande', /^Nous serons 12 pour un anniversaire samedi soir\./, 'Votre message'],
  ['/en/', 'Send a request', /^We’ll be 12 for a birthday on Saturday evening\./, 'Your message'],
  ['/es/', 'Hacer una solicitud', /^Seremos 12 para un cumpleaños el sábado por la noche\./, 'Su mensaje'],
] as const) {
  test(`${path}: a plain «Réserver» takes out the group request left as it was, and keeps the visitor’s own words`, async ({ page }) => {
    await open(page, path);
    const chat = page.locator('dialog.chat:not(.call)');
    const field = chat.getByRole('textbox', { name: message });
    const ask = page.getByRole('link', { name: request, exact: true });
    const book = page.locator('.site__book');

    await ask.click();
    await expect(field).toHaveValue(group);
    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    await book.click();
    await expect(chat).toBeVisible();
    await expect(field).toHaveValue('');
    await page.keyboard.press('Escape');

    await ask.click();
    await expect(field).toHaveValue(group);
    const edited = `${await field.inputValue()} +2`;
    await field.fill(edited);
    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    await book.click();
    await expect(field).toHaveValue(edited);
  });
}

test('opened on the night a chat booking is for, the first visit’s tour names that night and the way back to today', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tour-test')) return;
    sessionStorage.setItem('tour-test', 'started');
    localStorage.removeItem('maitre.tour');
    sessionStorage.setItem('maitre.chat', JSON.stringify(['day-of-month-en']));
  });
  await open(page, '/en/panel/');
  const tour = page.getByRole('dialog', { name: 'Panel tour' });
  await expect(tour.locator('#tour-body')).toHaveText(/: the panel opens on Saturday 24\sOctober, with its covers and its bookings\. “Today” brings back today’s service\.$/);
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
});

test('a restaurant opened from the English panel has its guests’ requests in English, from the first paint', async ({ page }) => {
  await page.addInitScript(() => {
    const french: string[] = [];
    Object.assign(window, { french });
    // Girard's note as the French evening writes it: not even the evening painted while the restaurant opens shows it.
    new MutationObserver(() => {
      if (document.body?.textContent?.includes('anniversaire')) french.push('anniversaire');
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await open(page, '/en/panel/');
  // The evening painted at once, then the restaurant opened in English once Cloudflare has vouched for the visitor.
  await expect(page.locator('.rows').filter({ hasText: 'Girard' })).toContainText('birthday');
  await expect.poll(() => demo.openedIn).toEqual(['en']);
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await page.locator('.chip--callback').click();
  await expect(page.getByText(/^Party of 9\sfor a birthday, Saturday 17\sOctober, in the evening\.$/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { french: string[] }).french)).toEqual([]);
});

test('the chat opens the restaurant in the page’s language', async ({ page }) => {
  await open(page, '/es/');
  await openChat(page);
  await expect(page.locator('dialog.chat:not(.call) .chat__chip').first()).toBeVisible();
  await expect.poll(() => demo.openedIn).toEqual(['es']);
});

test('what the chat booked waits for the first visit’s tour, and shows once it ends', async ({ page, isMobile }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tour-test')) return;
    sessionStorage.setItem('tour-test', 'started');
    localStorage.removeItem('maitre.tour');
    sessionStorage.setItem('maitre.chat', JSON.stringify(['day-of-month-en']));
  });
  await open(page, '/en/panel/');
  const tour = page.getByRole('dialog', { name: 'Panel tour' });
  await expect(tour).toBeVisible();
  const message = page.locator('.toast__text');
  const card = page.getByRole('region', { name: /^Table \d+/ });
  await expect(message).toBeEmpty();
  // On the phone the table's card is a sheet over the list and the bar the tour points at.
  if (isMobile) await expect(card).toBeHidden();
  else await expect(card).toBeVisible();
  await tour.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(message).toHaveText(/^New booking from Brown /);
  await expect(card).toContainText('Brown');
});

test('a booking from the chat for another night opens the panel on that night, at its table', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('maitre.chat', JSON.stringify(['day-of-month-en'])));
  await open(page, '/en/panel/');
  await expect(page.getByRole('heading', { name: /^Saturday 24/ })).toBeVisible();
  const card = page.getByRole('region', { name: /^Table \d+/ });
  await expect(card).toContainText('Brown');
  await expect(card.locator('.pill--new')).toBeVisible();
  await expectAccessible(page);
});

test('the chat keeps its conversation through a reload and a visit to the panel, until «Une autre demande»', async ({ page }) => {
  await open(page, '/');
  await openChat(page);
  const chat = page.locator('dialog.chat:not(.call)');
  const field = chat.getByRole('textbox', { name: 'Votre message' });
  await chat.getByRole('button', { name: 'Une table demain soir', exact: true }).click();
  await field.press('Enter');
  await expect(chat.locator('.chat__line--agent')).toHaveCount(2);
  await field.fill('Au nom de Lemoine');
  await field.press('Enter');
  const phone = chat.getByRole('textbox', { name: 'Votre numéro de téléphone' });
  await expect(phone).toBeVisible();

  // Reloaded, the conversation is where it was, its number field open, and the assistant's session goes on.
  await page.reload();
  await expect(page.locator('astro-island').first()).not.toHaveAttribute('ssr');
  await openChat(page);
  await expect(chat.locator('.chat__line--guest')).toHaveText([/Avez-vous une table pour 2/, /Au nom de Lemoine$/]);
  await phone.fill('06 39 98 00 21');
  await phone.press('Enter');
  await expect(chat.getByText('Réservation confirmée', { exact: true })).toBeVisible();

  // To the panel and back: still there, with the way to the panel.
  await open(page, '/panel/');
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await open(page, '/');
  await openChat(page);
  await expect(chat.getByText('Réservation confirmée', { exact: true })).toBeVisible();
  await expect(chat.getByRole('link', { name: 'Voir côté restaurant' })).toBeVisible();

  // Another request starts afresh, and that is what a reload finds.
  await chat.getByRole('button', { name: 'Une autre demande' }).click();
  await expect(chat.locator('.chat__line--guest')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('astro-island').first()).not.toHaveAttribute('ssr');
  await openChat(page);
  await expect(chat.locator('.chat__line--agent')).toHaveCount(1);
  await expect(chat.locator('.chat__line--guest')).toHaveCount(0);
});

test('a request the chat passes to the team is one more call to return on the panel', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/panel/');
  await expect(page.getByText('2 à rappeler')).toBeVisible();

  // «Groupes et privatisation» opens the chat with the request written, as a visitor finds it.
  await open(page, '/');
  await page.locator('[data-book="group"]').click();
  const chat = page.getByRole('dialog');
  await chat.getByRole('textbox', { name: 'Votre message' }).press('Enter');
  const phone = chat.getByRole('textbox', { name: 'Votre numéro de téléphone' });
  await phone.fill('06 39 98 00 24');
  await phone.press('Enter');
  await chat.getByRole('link', { name: 'Voir côté restaurant' }).click();

  await expect(page.getByText('3 à rappeler')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Nouvelle demande à rappeler sur le site');
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test('when the live demo is paused, the chat says so and plays a recorded conversation, said to be one', async ({ page }) => {
  const errors = watchErrors(page, /\/v1\/demo\/sandboxes$/);
  demo.failNext.open = { status: 503, error: 'live_paused' };
  await open(page, '/');
  await openChat(page);
  const chat = page.getByRole('dialog');
  await expect(chat.getByRole('status')).toHaveText(/^Le chat en direct est en pause pour le moment\./);
  await expect(chat.locator('.chat__status')).toHaveText('Pas en direct pour le moment');
  await expect(chat.getByRole('group', { name: 'Partir d’un exemple' })).toHaveCount(0);
  await chat.getByRole('button', { name: 'Voir une conversation enregistrée' }).click();
  await expect(chat.locator('.chat__status')).toHaveCount(0);
  await expect(chat.locator('.chat__notice')).toHaveText(/^Le chat en direct n’est pas disponible pour le moment\. Ces conversations ont été enregistrées/);
  await expect(chat.getByRole('group', { name: 'Choisissez une conversation enregistrée' })).toBeVisible();
  await chat.getByRole('button', { name: /^Bonsoir, je voudrais réserver une table pour 4/ }).click();
  await expect(chat.getByText('Réservation confirmée', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expectAccessible(page);

  // The panel shows the recorded booking in the evening of the browser, and its bar says it is not live.
  await chat.getByRole('link', { name: 'Voir côté restaurant' }).click();
  await expect(page.getByRole('status')).toContainText('Mercier sur le site');
  await expect(page.locator('.demo-bar__note')).toHaveText(/, 20\sh\s\d\d \(pas en direct\)$/);
  expect(errors).toEqual([]);
});

test('the chat says what stopped a message, and keeps it to send again', async ({ page }) => {
  await open(page, '/');
  await openChat(page);
  const chat = page.getByRole('dialog');
  const field = chat.getByRole('textbox', { name: 'Votre message' });
  await field.fill('Êtes-vous ouverts dimanche soir ?');

  demo.failNext.chat = { status: 429, error: 'rate_limited' };
  await field.press('Enter');
  await expect(chat.getByRole('status')).toHaveText(/^Trop de messages d’affilée/);
  await expect(field).toHaveValue(/^Êtes-vous ouverts dimanche soir/);

  demo.failNext.chat = { status: 429, error: 'sandbox_limit' };
  await field.press('Enter');
  await expect(chat.getByRole('status')).toContainText('Vous avez envoyé à ce restaurant tous les messages');
  await chat.getByRole('button', { name: 'Ouvrir un nouveau restaurant' }).click();
  await expect(chat.getByRole('status')).toHaveCount(0);
  await field.press('Enter');
  await expect(chat.locator('.chat__line--agent')).toHaveCount(2);
});

test('the first visit to the panel opens a short tour, and it does not come back', async ({ page }) => {
  // Only the first load starts without the tour seen: the reload below is the same visitor coming back.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tour-test')) return;
    sessionStorage.setItem('tour-test', 'started');
    localStorage.removeItem('maitre.tour');
  });
  await open(page, '/panel/');
  const tour = page.getByRole('dialog', { name: 'Découvrir le panel' });
  await expect(tour).toBeVisible();
  await expect(tour.getByRole('heading', { name: 'Vous gérez Merrain', exact: true })).toBeFocused();
  await expect(tour).toContainText(/^.*vendredi 16\soctobre, 20\sh\s0[56]\s: le service du jour/);
  await expect(tour).toContainText('1 sur 4');
  await expectAccessible(page);
  for (const step of ['La salle, en direct', 'Ce qui demande votre attention', 'Tout ce que fait l’assistant']) {
    await tour.getByRole('button', { name: 'Suivant' }).click();
    await expect(tour.getByRole('heading', { name: step })).toBeVisible();
  }
  // The last step points at the rail, a bar along the bottom on the phone: its card stays clear of it.
  await expect(tour).toContainText(/Conversations\s: chaque échange avec vos clients, mot pour mot\./);
  const card = await tour.boundingBox();
  const rail = await page.locator('.rail').boundingBox();
  const apart = card && rail && (card.y + card.height <= rail.y || rail.x + rail.width <= card.x || card.x + card.width <= rail.x);
  expect(apart).toBe(true);
  await tour.getByRole('button', { name: 'Compris' }).click();
  await expect(tour).toHaveCount(0);

  await page.reload();
  await expect(page.locator('astro-island').first()).not.toHaveAttribute('ssr');
  await expect(page.getByRole('dialog', { name: 'Découvrir le panel' })).toHaveCount(0);
});

test('the tour shows by itself once: leaving the service or reloading in the middle of it does not bring it back', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tour-test')) return;
    sessionStorage.setItem('tour-test', 'started');
    localStorage.removeItem('maitre.tour');
  });
  await open(page, '/panel/');
  const tour = page.getByRole('dialog', { name: 'Découvrir le panel' });
  await expect(tour).toBeVisible();
  // The second step leaves the rail in sight on the phone too, where the first one's card covers the bar.
  await tour.getByRole('button', { name: 'Suivant' }).click();
  const rail = page.getByRole('navigation', { name: 'Rubriques' });
  await rail.getByRole('link', { name: 'Réglages' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
  await rail.getByRole('link', { name: 'Service' }).click();
  await expect(page.locator('.services')).toBeVisible();
  // It would open from an effect a frame after the service is back: past that, it is not coming.
  await page.waitForTimeout(300);
  await expect(tour).toHaveCount(0);

  await page.reload();
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.services')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(tour).toHaveCount(0);
  await page.getByRole('button', { name: 'Visite guidée' }).click();
  await expect(tour).toContainText('1 sur 4');
});

test('the tour can be skipped with Escape', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('maitre.tour'));
  await open(page, '/panel/');
  const tour = page.getByRole('dialog', { name: 'Découvrir le panel' });
  await expect(tour).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tour).toHaveCount(0);
});

test('every table on the plan is named first by what it shows, as voice control needs (WCAG 2.5.3)', async ({ page }) => {
  await open(page, '/panel/');
  await showPlan(page);
  await expect(page.getByRole('button', { name: /^4, Roux 20:30, / })).toBeVisible();
  // An experimental rule in axe, so not among those it runs by default.
  const { violations } = await new AxeBuilder({ page }).include('.plan').withRules(['label-content-name-mismatch']).analyze();
  expect(violations.flatMap((violation) => violation.nodes.map((node) => node.target.join(' ')))).toEqual([]);
});

test('the restaurant’s side says who the visitor is, and when, by the restaurant’s own clock', async ({ page }) => {
  await open(page, '/panel/');
  const line = page.locator('.demo-bar__note');
  // Live, and today's service still going: nothing after the time. The clock is the real one, with no button to move it.
  await expect(line).toHaveText(/^Démo\s: vous gérez Merrain, vendredi 16\soctobre, 20\sh\s0[56]$/);
  await expect(page.getByRole('button', { name: /^Avancer/ })).toHaveCount(0);
});

test('on a day the restaurant is closed, the panel opens on the next service, and the bar says so', async ({ page }) => {
  // Monday 19 October at 15:00 in Bordeaux: Merrain closes on Mondays.
  demo = new FakeDemo(new Date('2026-10-19T13:00:00.000Z'));
  await demo.install(page);
  await open(page, '/panel/');
  await expect(page.locator('.demo-bar__note')).toHaveText(/^Démo\s: vous gérez Merrain, lundi 19\soctobre, 15\sh(\s01)?, prochain service mardi$/);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('mardi 20 octobre');
  await expectAccessible(page);
});

test('after the last seating, a booking by hand starts on the next day with a time to book', async ({ page }) => {
  // Friday 16 October at 23:30 in Bordeaux: no time is left to book tonight.
  demo = new FakeDemo(new Date('2026-10-16T21:30:00.000Z'));
  await demo.install(page);
  await open(page, '/panel/');
  await page.getByRole('button', { name: 'Nouvelle réservation' }).click();
  const form = page.getByRole('dialog', { name: 'Nouvelle réservation' });
  await expect(form.getByLabel('Date')).toHaveValue('2026-10-17');
  await expect(form.getByLabel('Heure')).not.toHaveValue('');
  // Tonight is not closed: its times have passed, and the sheet says so.
  await form.getByLabel('Date').fill('2026-10-16');
  await expect(form.getByText(/^Toutes les heures d’aujourd’hui sont passées\s: choisissez un autre jour\.$/)).toBeVisible();
  await expect(form.getByRole('button', { name: 'Réserver' })).toBeDisabled();
});

for (const [panel, closed, next] of [
  [PANELS[0], /^Client sur place\s: seulement pendant le service\.$/, /^dîner\s: arrivées de 19:00 à 21:30$/],
  [PANELS[1], /^At the door: only during service\.$/, /^dinner: seating from 19:00 to 21:30$/],
  [PANELS[2], /^Sin reserva: solo durante el servicio\.$/, /^cena: llegadas de 19:00 a 21:30$/],
] as const) {
  test(`${panel.path}: between services a party at the door is told when the next one opens, not offered a size`, async ({ page }) => {
    // Friday at 14:35: lunch took its last guests at 13:45, and dinner seats from 19:00.
    demo = new FakeDemo(new Date('2026-10-16T12:35:00.000Z'));
    await demo.install(page);
    await open(page, panel.path);
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await page.locator('.topbar__walk-in .topbar__action').click();
    const popover = page.locator('#walk-in-sizes-bar');
    await expect(popover.locator('p')).toHaveText([closed, next]);
    await expect(popover.locator('.action--size')).toHaveCount(0);
    await expectAccessible(page);
    await page.keyboard.press('Escape');

    // A free table's card says the same.
    await showPlan(page, panel.plan);
    await page.locator('.table.is-free').first().dispatchEvent('click');
    const card = page.locator('.card');
    await expect(card.locator('.card__group').first().locator('p')).toHaveText([closed, next]);
    await expect(card.locator('.action--size')).toHaveCount(0);
  });
}

test('after the last seating of the day, a party at the door is told the next open day’s first service', async ({ page }) => {
  // Friday at 21:45: dinner is still on, its last seating gone; Saturday's lunch is next.
  demo = new FakeDemo(new Date('2026-10-16T19:45:00.000Z'));
  await demo.install(page);
  await open(page, '/panel/');
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await page.locator('.topbar__walk-in .topbar__action').click();
  await expect(page.locator('#walk-in-sizes-bar .wait__next')).toHaveText(/^samedi 17\soctobre, déjeuner\s: arrivées de 12:00 à 13:45$/);
});

for (const panel of PANELS) {
  test(`${panel.path} is the restaurant’s panel, full screen, with nothing for axe to report`, async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, panel.path);

    await expect(page.locator('html')).toHaveAttribute('lang', panel.lang);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(panel.heading);
    await expect(page.getByRole('listitem').filter({ hasText: 'Moreau' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: panel.walkIn })).toBeVisible();
    await expectAccessible(page);

    await showPlan(page, panel.plan);
    await expect(page.getByRole('group', { name: /plan|plano/i })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });
}

test('every page runs under a policy that allows only its own scripts, by hash, and Turnstile', async ({ page }) => {
  for (const path of [...SITES, ...PANELS, ...LEGALS, ...NOT_FOUND].map((entry) => entry.path)) {
    await page.goto(path);
    const scripts = await policy(page, 'script-src');
    expect(scripts, path).toMatch(/^script-src 'self' https:\/\/challenges\.cloudflare\.com( 'sha256-[A-Za-z0-9+/=]+')+$/);
    expect(await policy(page, 'frame-src'), path).toBe('frame-src https://challenges.cloudflare.com');
    expect(await policy(page, 'style-src'), path).not.toContain('unsafe');
    expect(await policy(page, 'default-src'), path).toBe("default-src 'self'");
    // Images from the site, and the tab's icon written into the page: none from anywhere else.
    expect(await policy(page, 'img-src'), path).toBe("img-src 'self' data:");
  }
});

for (const legal of LEGALS) {
  test(`${legal.path} says who publishes the demo and what the chat and the call keep, with nothing for axe to report`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(legal.path);
    await expect(page.locator('html')).toHaveAttribute('lang', legal.lang);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(legal.heading);
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(9);
    await expect(page.getByRole('heading', { level: 2, name: legal.call })).toBeVisible();
    // The publisher is reached through these three, given once, where the publisher is named.
    await expect(page.getByRole('link', { name: 'LinkedIn' })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Migue Studio' }).first()).toHaveAttribute('href', 'https://miguestudio.me');
    await expect(page.locator('main')).not.toContainText('[');
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });
}

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

test.describe('Merrain’s site', () => {
  test('the menu opens from its button, leads to a section, and closes', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/');
    const toggle = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('navigation', { name: 'Sections du site' });
    await expect(menu.getByRole('link', { name: 'La cave' })).toBeVisible();
    await expectAccessible(page);

    await menu.getByRole('link', { name: 'Horaires d’ouverture' }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page).toHaveURL(/#horaires$/);

    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('the menu’s two thin lines cross where they stand as it opens, and part again as it closes', async ({ page }) => {
    await open(page, '/');
    const toggle = page.getByRole('button', { name: 'Menu', exact: true });
    const shut = await toggle
      .locator('.site__lines')
      .evaluate((lines) => ['::before', '::after'].map((part) => ({ height: getComputedStyle(lines, part).height, transform: getComputedStyle(lines, part).transform })));
    expect(shut.map((line) => line.height)).toEqual(['1.5px', '1.5px']);
    expect(shut.map((line) => line.transform)).toEqual(['none', 'none']);

    await toggle.click();
    const close = page.getByRole('button', { name: 'Fermer', exact: true });
    await expect(close).toBeFocused();
    // The cross stands exactly where the lines were, at the same size.
    const box = (rect: { x: number; y: number; width: number; height: number } | null) => rect && [rect.x, rect.y, rect.width, rect.height].map(Math.round);
    expect(box(await close.boundingBox())).toEqual(box(await toggle.boundingBox()));
    // Each line turned 45°, the two of them about the middle.
    await expect
      .poll(() => close.locator('.site__lines').evaluate((element) => getComputedStyle(element, '::before').transform))
      .toMatch(/^matrix\(0\.7071\d*, 0\.7071\d*, -0\.7071\d*, 0\.7071\d*, 0, 3\.5\)$/);
    expect(await close.locator('.site__lines').evaluate((element) => getComputedStyle(element, '::before').transitionDuration)).toBe('0.24s');

    await close.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });

  test('with less motion asked for, the cross comes at once', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '/');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const close = page.getByRole('button', { name: 'Fermer', exact: true });
    await expect(close).toBeFocused();
    expect(await close.locator('.site__lines').evaluate((element) => getComputedStyle(element, '::before').transitionDuration)).toBe('0s');
  });

  test('«Réserver» at the top opens the booking itself, and the page says each thing once', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/');
    const book = page.locator('.site__book');
    await page.locator('#carte').evaluate((section) => section.scrollIntoView());
    await book.click();
    const chat = page.getByRole('dialog', { name: 'Réserver chez Merrain' });
    await expect(chat).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    await expect(book).toBeFocused();

    // One booking screen, with one way to the assistant and the call beside it; the demo said once, in its bar.
    await expect(page.getByText(/^Les réservations sont ouvertes/)).toHaveCount(1);
    await expect(page.locator('#reserver [data-book]')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Posez-la à l’assistant' })).toHaveCount(0);
    await expect(page.locator('a[href="/panel/"]')).toHaveCount(1);
    await expect(page.getByText('Données inventées pour la démonstration')).toHaveCount(1);
    await expect(page.getByText(/générées pour la démonstration/)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the cover is the film under a white card, and its chevron leads to the menu', async ({ page }) => {
    await open(page, '/');
    await expect(page.locator('.cover__card').getByRole('heading', { level: 1 })).toHaveText('Merrain');
    const next = page.getByRole('link', { name: 'Voir la carte' });
    await expect(next).toHaveAttribute('href', '#carte');
    await next.click();
    await expect(page).toHaveURL(/#carte$/);
  });

  test('«Groupes et privatisation» opens the chat with the request ready to send', async ({ page }) => {
    await open(page, '/');
    await expect(page.locator('#groupes')).toContainText('À partir de 7');
    await page.locator('[data-book="group"]').click();
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Votre message' })).toHaveValue(/^Nous serons 12/);
  });

  test('the cellar is said once, with a short selection by bank, each name on one line down to a 320 px screen', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, '/');
    await expect(page.locator('#maison')).not.toContainText('cave');
    await expect(page.locator('.cellar dt')).toHaveText(['Rive gauche', 'Rive droite', 'Blancs secs et liquoreux']);
    await expect(page.locator('.cellar span')).toHaveCount(9);
    await page.evaluate(() => document.fonts.ready);
    const split = await page.locator('.cellar span').evaluateAll((names) => names.filter((name) => name.getClientRects().length > 1).map((name) => name.textContent));
    expect(split).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });

  test('the photographs are decorative and sized, and only the cover’s loads at once', async ({ page }) => {
    await page.goto('/');
    const images = page.locator('.backdrop img, .screen__photo img');
    await expect(images).toHaveCount(15);
    for (const image of await images.all()) {
      await expect(image).toHaveAttribute('alt', '');
      await expect(image).toHaveAttribute('width', /^\d+$/);
      await expect(image).toHaveAttribute('height', /^\d+$/);
    }
    const [first, ...rest] = await images.all();
    await expect(first!).toHaveAttribute('fetchpriority', 'high');
    await expect(first!).not.toHaveAttribute('loading', 'lazy');
    for (const image of rest) await expect(image).toHaveAttribute('loading', 'lazy');
    await expect(page.locator('.backdrop source[type="image/avif"], .screen__photo source[type="image/avif"]')).toHaveCount(15);
  });

  test('behind the panels, each screen’s photograph is armed one screen ahead and fades in with its screen', async ({ page, isMobile }) => {
    test.skip(isMobile, 'On the phone the photographs sit above each screen, in the page.');
    await open(page, '/');
    const layer = (id: string) => page.locator(`.backdrop__layer[data-section="${id}"]`);
    await expect(layer('accueil')).toHaveClass(/is-shown/);
    await expect(layer('carte')).not.toHaveAttribute('hidden');
    await expect(layer('maison')).toHaveAttribute('hidden');
    await page.locator('#maison').evaluate((section) => section.scrollIntoView());
    await expect(layer('maison')).toHaveClass(/is-shown/);
    await expect(layer('cave')).not.toHaveAttribute('hidden');
    await expect(layer('accueil')).not.toHaveClass(/is-shown/);
  });

  test('the cover’s film stays for as long as any of the cover shows, and each photograph comes in over the last', async ({ page, isMobile }) => {
    await open(page, '/');
    await page.evaluate(() => (document.documentElement.style.scrollBehavior = 'auto'));
    const film = page.locator('.backdrop__layer--cover');
    const layer = (id: string) => page.locator(`.backdrop__layer[data-section="${id}"]`);
    // The cover's last third still on screen, the menu's screen already past the middle of the window: what the
    // cover leaves transparent shows the film, never the black behind the layers.
    await page.evaluate(() => scrollTo(0, document.getElementById('accueil')!.getBoundingClientRect().bottom + scrollY - innerHeight / 3));
    await expect(film).toHaveClass(/is-shown/);
    await expect(film).toHaveCSS('opacity', '1');
    await expect(layer('carte')).not.toHaveClass(/is-shown/);
    if (isMobile) return;

    // Once the cover has gone, the menu's photograph comes in front, and only the layer in front fades.
    await page.locator('#carte').evaluate((section) => section.scrollIntoView());
    await expect(layer('carte')).toHaveClass(/is-shown/);
    await expect(layer('carte')).toHaveClass(/is-front/);
    await expect(layer('carte')).toHaveCSS('transition-duration', '0.4s');
    await expect(film).not.toHaveClass(/is-shown/);

    // Back to the cover: the film is whole at once, under the photograph, which fades away above it.
    await page.evaluate(() => scrollTo(0, 0));
    await expect(film).toHaveClass(/is-shown/);
    await expect(film).not.toHaveClass(/is-front/);
    await expect(film).toHaveCSS('opacity', '1');
    await expect(layer('carte')).not.toHaveClass(/is-shown/);
  });

  test('the menu’s lines keep 3:1 or more on their white square, over the film, the photographs and the panels', async ({ page, isMobile }) => {
    await open(page, '/');
    await page.evaluate(() => (document.documentElement.style.scrollBehavior = 'auto'));
    const contrasts: Record<string, number> = { cover: await linesContrast(page) };
    // On the phone each screen's photograph passes under the lines: three of them, light and dark, at their middle.
    for (const id of isMobile ? ['carte', 'groupes', 'infos'] : []) {
      // Twice: the lines move up once the bar has gone and the chrome sticks to the top.
      for (let pass = 0; pass < 2; pass += 1) {
        await page.evaluate((id) => {
          const photo = document.querySelector(`#${id} .screen__photo`)!.getBoundingClientRect();
          scrollBy(0, photo.top + photo.height / 2 - document.querySelector('.site__toggle .site__lines')!.getBoundingClientRect().top);
        }, id);
      }
      await expect(page.locator(`#${id} .screen__photo img`)).toHaveJSProperty('complete', true);
      await page.waitForTimeout(100);
      contrasts[id] = await linesContrast(page);
    }
    await page.locator('#horaires .site__label').evaluate((title) => scrollBy(0, title.getBoundingClientRect().top - 30));
    await page.waitForTimeout(100);
    contrasts['panel'] = await linesContrast(page);
    for (const [where, contrast] of Object.entries(contrasts)) expect(contrast, where).toBeGreaterThanOrEqual(3);
  });
});

/** Texts on the page not set as the copy is: a number apart from the word after it, or a straight apostrophe in a word. */
function unsetTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // A guest's words are theirs: the panel shows them as they were written.
      if (node.parentElement?.closest('script, style, .bubble--guest, .talk__said')) continue;
      // A clock time's minutes are not the unit of the word after them: «21 h 30 est libre», «21:30 está libre».
      const text = (node.textContent ?? '').replace(/\d{1,2}(?::| h )\d{2}(?! ?[ap]m\b)/gu, 'TIME');
      if (/\d [\p{L}€%]|\p{L}'\p{L}/u.test(text)) found.push(text.trim().slice(0, 80));
    }
    return found;
  });
}

test('every text is set as the copy is, on the site, in the chat and on the panel: numbers with their units, typographic apostrophes', async ({ page }) => {
  const unset = () => unsetTexts(page);

  // The recorded conversations carry the model's own words, apostrophes and all: the chat is paused to play one.
  demo.failNext.open = { status: 503, error: 'live_paused' };
  await open(page, '/');
  expect(await unset()).toEqual([]);

  await openChat(page);
  const chat = page.getByRole('dialog');
  await chat.getByRole('button', { name: 'Voir une conversation enregistrée' }).click();
  await chat.getByRole('button', { name: /^Bonsoir, je voudrais réserver une table pour 4/ }).click();
  const toPanel = chat.getByRole('link', { name: 'Voir côté restaurant' });
  await expect(toPanel).toBeVisible({ timeout: 20_000 });
  expect(await unset()).toEqual([]);

  await toPanel.click();
  await expect(page.locator('.card .pill--new')).toBeVisible();
  expect(await unset()).toEqual([]);
  // On a wide screen the card stands where the list was: closed, it gives the list back.
  await page.locator('.card__close').click();
  await expect(page.locator('.rows .pill--new').first()).toBeVisible();
  expect(await unset()).toEqual([]);
});

test('nothing moves once the panel has read its restaurant: the bar’s time and the rail had their room from the first paint', async ({ page }) => {
  // Each shift with what it moved and from where to where: on a failure, the report says which part moved.
  await page.addInitScript(() => {
    type Shift = PerformanceEntry & { value: number; sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] };
    const shifts: { value: number; moved: string[] }[] = [];
    Object.assign(window, { shifts });
    const named = (node: Node | null) => (node instanceof Element ? `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}` : `text in ${node?.parentElement?.className}`);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Shift[]) {
        shifts.push({
          value: entry.value,
          moved: entry.sources.map(({ node, previousRect: from, currentRect: to }) => `${named(node)} ${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(to.x)},${Math.round(to.y)}`),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await open(page, '/panel/');
  await expect(page.locator('#demo-when')).not.toBeEmpty();
  await expect(page.locator('.rail__item')).toHaveCount(4);
  const shifts = await page.evaluate(() => (window as unknown as { shifts: { value: number; moved: string[] }[] }).shifts);
  // The fonts, as they arrive, move a letter; the panel itself does not move.
  expect(shifts.reduce((sum, shift) => sum + shift.value, 0), JSON.stringify(shifts, null, 1)).toBeLessThan(0.001);
});

test('between the phone and a wide screen the panel’s bar keeps its time and actions together, on a row of their own when short of room', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The window is resized by hand here.');
  for (const [width, rows] of [
    [1024, 2],
    [1180, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await open(page, '/panel/');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    const shape = await page.locator('.topbar').evaluate((bar) => {
      const brand = bar.querySelector('.topbar__brand')!.getBoundingClientRect();
      const end = bar.querySelector('.topbar__end')!.getBoundingClientRect();
      const primary = bar.querySelector('.topbar__action--primary')!.getBoundingClientRect();
      return { rows: end.top > brand.bottom ? 2 : 1, together: Math.abs(primary.top - end.top) < 10 };
    });
    expect(shape, `${width}`).toEqual({ rows, together: true });
    // Only their icon shows there; their names stay for a screen reader.
    await expect(page.getByRole('button', { name: 'Visite guidée', exact: true })).toBeVisible();
  }
});

test.describe('the panel fills the screen, and not one pixel more', () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const fromChat of [false, true]) {
      test(`at ${viewport.width} × ${viewport.height}${fromChat ? ', with a booking from the chat' : ''}`, async ({ page, isMobile }) => {
        test.skip(isMobile, 'On the phone the page scrolls with the list.');
        await page.setViewportSize(viewport);
        if (fromChat) await page.addInitScript(() => sessionStorage.setItem('maitre.chat', JSON.stringify(['web-book-fr'])));
        await open(page, '/panel/');
        if (fromChat) await expect(page.locator('.card .pill--new')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(viewport.height);
        expect(await page.locator('.app__main').evaluate((main) => Math.round(main.getBoundingClientRect().bottom))).toBe(viewport.height);
      });
    }
  }

  test('with the first visit’s tour open, the panel still reaches the bottom of the screen', async ({ page, isMobile }) => {
    test.skip(isMobile, 'On the phone the page scrolls with the list.');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.removeItem('maitre.tour'));
    await open(page, '/panel/');
    await expect(page.locator('.tour__card')).toBeVisible();
    expect(await page.locator('.app__main').evaluate((main) => Math.round(main.getBoundingClientRect().bottom))).toBe(900);
  });

  test('and so does each section, its own content scrolling inside it', async ({ page, isMobile }) => {
    test.skip(isMobile, 'On the phone the page scrolls with the section.');
    // A long conversation: what would stretch the page if anything in it escaped its scroll.
    for (let index = 0; index < 14; index += 1) {
      demo.turns.push({
        at: `2026-10-16T17:${String(10 + index).padStart(2, '0')}:00.000Z`,
        sessionId: 'long',
        channel: 'whatsapp',
        language: 'fr',
        guest: 'Et pour le dessert, la mousse au chocolat contient-elle des fruits à coque ?',
        reply: 'D’après la fiche de la cuisine, la mousse ne précise pas les fruits à coque : je transmets votre question à l’équipe.',
        outcome: 'answered',
        latencyMs: 2300,
        modelCalls: 2,
        usage: {},
        costUsd: 0.001,
        tools: [{ name: 'check_dish', status: 'ok' }],
        corrections: ['allergen_relay'],
      });
    }
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      for (const [section, title] of [
        ['conversations', 'Conversations'],
        ['activity', 'Activité'],
        ['settings', 'Réglages'],
      ] as const) {
        await open(page, `/panel/#${section}`);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        if (section === 'conversations') await expect(page.locator('.bubble--assistant')).toHaveCount(14);
        expect(await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])).toEqual([viewport.width, viewport.height]);
      }
    }
  });

  test('on the phone no section is wider than the screen, the menu’s sheets included', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'A wider screen has room to spare.');
    for (const [section, title] of [
      ['conversations', 'Conversations'],
      ['activity', 'Activité'],
      ['settings', 'Réglages'],
    ] as const) {
      await open(page, `/panel/#${section}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()?.width);
    }
  });
});

test.describe('the panel’s sections, down its rail', () => {
  test('the rail leads to each section, at an address of its own that the browser’s arrows follow', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/');
    const rail = page.getByRole('navigation', { name: 'Rubriques' });
    await expect(rail.getByRole('link')).toHaveText(['Service', 'Conversations', 'Activité', 'Réglages']);
    await expect(rail.getByRole('link', { name: 'Service' })).toHaveAttribute('aria-current', 'page');
    await expectAccessible(page);
    await rail.getByRole('link', { name: 'Réglages' }).click();
    await expect(page).toHaveURL(/\/panel\/#settings$/);
    // The section's name takes the focus, so a screen reader hears where the rail went.
    await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeFocused();
    await expect(rail.getByRole('link', { name: 'Réglages' })).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Salle de Merrain' })).toBeAttached();
    await expect(rail.getByRole('link', { name: 'Service' })).toHaveAttribute('aria-current', 'page');
    expect(errors).toEqual([]);
  });

  test('the recorded evening keeps no conversations: its rail leads to the service and the settings only', async ({ page }) => {
    demo.status = { live: false, calls: null };
    await open(page, '/panel/#conversations');
    await expect(page.locator('.demo-bar__note')).toHaveText(/\(pas en direct\)$/);
    await expect(page.getByRole('navigation', { name: 'Rubriques' }).getByRole('link')).toHaveText(['Service', 'Réglages']);
    // Asked for a section it cannot fill, the panel shows the service.
    await expect(page.getByRole('heading', { level: 1, name: 'Salle de Merrain' })).toBeAttached();
  });

  test('a first visit straight to a section keeps the tour for the service, which it points at', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('maitre.tour'));
    await open(page, '/panel/#settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
    const tour = page.getByRole('dialog', { name: 'Découvrir le panel' });
    await expect(tour).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Rubriques' }).getByRole('link', { name: 'Service' }).click();
    await expect(tour).toBeVisible();
  });

  test('Conversations, before the first, says what will arrive there', async ({ page }) => {
    await open(page, '/panel/#conversations');
    await expect(page.getByText(/^Aucune conversation pour l’instant\. Celles de vos clients avec l’assistant/)).toBeVisible();
    await expectAccessible(page);
  });

  test('Conversations reads as a thread: who wrote, their words, the booking it made, and the details behind', async ({ page }) => {
    const errors = watchErrors(page);
    // A guest books in the site's chat.
    await open(page, '/');
    await openChat(page);
    const chat = page.getByRole('dialog');
    const field = chat.getByRole('textbox', { name: 'Votre message' });
    await chat.getByRole('button', { name: 'Une table demain soir', exact: true }).click();
    await field.press('Enter');
    await expect(chat.locator('.chat__line--agent')).toHaveCount(2);
    await field.fill('Au nom de Lemoine');
    await field.press('Enter');
    const phone = chat.getByRole('textbox', { name: 'Votre numéro de téléphone' });
    await phone.fill('06 39 98 00 21');
    await phone.press('Enter');
    await expect(chat.getByText('Réservation confirmée', { exact: true })).toBeVisible();

    await open(page, '/panel/#conversations');
    const row = page.getByRole('list', { name: 'Conversations récentes' }).getByRole('button');
    await expect(row).toHaveCount(1);
    // Who wrote, when, what it came to, said as the guest heard it, and the guest's last words before the number.
    await expect(row.locator('.talk__who')).toHaveText('Lemoine');
    await expect(row.locator('.talk__when')).toHaveText('20:05');
    await expect(row.locator('.talk__line')).toHaveText(/^Web, réservé\s: une table pour 2\spersonnes le samedi 17\soctobre à 20\sh\s30$/);
    await expect(row.locator('.talk__said')).toHaveText('Au nom de Lemoine');
    // Side by side the latest is open already; on the phone it opens from the list.
    if (!(await page.locator('.transcript').isVisible())) await row.click();
    const thread = page.locator('.transcript');
    await expect(thread.getByRole('heading', { level: 2 })).toHaveText('Lemoine');
    await expect(thread.locator('.transcript__facts')).toHaveText('Web, 20:05, français, +33 6 39 98 00 21');
    await expect(thread.getByRole('link', { name: '+33 6 39 98 00 21' })).toHaveAttribute('href', 'tel:+33639980021');
    await expect(thread.locator('.bubble--guest').first()).toContainText('Avez-vous une table pour 2 demain soir à 20');
    await expect(thread.locator('.bubble--assistant')).toHaveCount(3);
    await expect(thread.locator('.event--booked')).toHaveText(/^Réservé\s: une table pour 2\spersonnes le samedi 17\soctobre à 20\sh\s30$/);
    // The number itself is the conversation's, not a message: the thread says it was typed.
    await expect(thread.locator('.event', { hasText: 'Numéro saisi par le client' })).toBeVisible();
    // What the assistant asked the engine waits behind one line, closed.
    const details = thread.locator('details.tech');
    expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    await expect(details.locator('.tech__list').first()).toBeHidden();
    await expectAccessible(page);
    // The panel announced the chat's booking; on the phone its message sits above the bar, where the details are.
    await page.getByRole('button', { name: 'Fermer le message' }).click();
    await details.locator('summary').click();
    await expect(details.locator('.tech__list').first()).toContainText('Chercher une table');
    await expect(details.locator('.tech__status').first()).toHaveText('libre');
    await expect(details.locator('.tech__line').first()).toHaveText(/^Réponse en 2,4\ss, coût 0,0011\s\$$/);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test('a call reads as the line heard it: who called, how long, how it ended, and behind it how fast the restaurant answered', async ({ page }) => {
    demo.calls.push({
      sessionId: 'call-a',
      startedAt: '2026-10-16T17:50:00.000Z',
      language: 'en',
      endedAt: '2026-10-16T17:53:12.000Z',
      seconds: 192,
      endedBy: 'goodbye',
      voiceToVoiceMs: [900, 1100, 1300],
    });
    demo.turns.push({
      at: '2026-10-16T17:50:20.000Z',
      sessionId: 'call-a',
      channel: 'voice',
      language: 'en',
      guest: 'Do you have a table for four on Saturday at eight?',
      reply: 'I have a table for 4 on Saturday 17 October at 8 pm. What name should it be under?',
      outcome: 'answered',
      latencyMs: 2100,
      modelCalls: 2,
      usage: {},
      costUsd: 0.0012,
      tools: [{ name: 'find_table', status: 'available' }],
      corrections: ['guessed_title'],
      phone: '+44 7700 900123',
    });
    await open(page, '/panel/#conversations');
    const row = page.getByRole('list', { name: 'Conversations récentes' }).getByRole('button').first();
    await expect(row.locator('.talk__who')).toHaveText('+44 7700 900123');
    await expect(row.locator('.talk__line')).toHaveText('Téléphone, renseignement');
    await expect(row.locator('.talk__said')).toHaveText('Do you have a table for four on Saturday at eight?');
    await expect(row.locator('.talk__call')).toHaveText(/^3\smin\s12\ss, raccroché après l’au revoir$/);
    if (!(await page.locator('.transcript').isVisible())) await row.click();
    const thread = page.locator('.transcript');
    await expect(thread.locator('.transcript__facts')).toHaveText(/^Téléphone, 19:50, anglais, 3\smin\s12\ss, raccroché après l’au revoir$/);
    await expect(thread.locator('.bubble--guest p[lang]')).toHaveAttribute('lang', 'en');
    const details = thread.locator('details.tech');
    await details.locator('summary').click();
    await expect(details.locator('.tech__line').first()).toHaveText(/^Répond en 1,1\ss$/);
    await expect(details.locator('.tech__group').last()).toHaveText(/^Règle appliquée par le code\s*Civilité devinée retirée$/);
    await expectAccessible(page);
  });

  test('a conversation logged before the Worker said what each turn did still says what it came to', async ({ page }) => {
    demo.turns.push({
      at: '2026-10-16T17:30:00.000Z',
      sessionId: 'old',
      channel: 'whatsapp',
      language: 'fr',
      guest: 'Je confirme pour ce soir.',
      reply: 'Merci, c’est noté.',
      outcome: 'answered',
      latencyMs: 1500,
      modelCalls: 2,
      usage: {},
      tools: [{ name: 'book_table', status: 'booked' }],
      corrections: [],
    });
    await open(page, '/panel/#conversations');
    const row = page.getByRole('list', { name: 'Conversations récentes' }).getByRole('button').first();
    await expect(row.locator('.talk__who')).toHaveText('WhatsApp');
    await expect(row.locator('.talk__line')).toHaveText('Réservation');
  });

  test('on the phone a conversation opens over the list, and «Toutes les conversations» goes back to it', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'A wider screen shows the list and the conversation side by side.');
    demo.turns.push({
      at: '2026-10-16T17:40:00.000Z',
      sessionId: 'web-a',
      channel: 'web',
      language: 'fr',
      guest: 'Vous êtes ouverts dimanche soir ?',
      reply: 'Le dimanche, Merrain sert le déjeuner seulement.',
      outcome: 'answered',
      latencyMs: 1500,
      modelCalls: 2,
      usage: {},
      tools: [{ name: 'opening_hours', status: 'ok' }],
      corrections: [],
    });
    await open(page, '/panel/#conversations');
    const row = page.getByRole('list', { name: 'Conversations récentes' }).getByRole('button').first();
    await expect(page.locator('.transcript')).toHaveCount(0);
    await row.click();
    await expect(page.getByRole('heading', { level: 2, name: 'Web' })).toBeFocused();
    await expect(page.locator('.bubble--assistant')).toHaveText(/Le dimanche, Merrain sert le déjeuner seulement\./);
    await page.getByRole('button', { name: 'Toutes les conversations' }).click();
    await expect(row).toBeFocused();
  });

  test('Activité counts what the assistant did, the calls taken while the restaurant was closed first', async ({ page }) => {
    const errors = watchErrors(page);
    demo.activity = {
      bookings: { made: 5, covers: 14, byChannel: { web: 2, whatsapp: 1, voice: 1, staff: 1 } },
      conversations: { written: 3, turns: 11, passedToTeam: 1 },
      calls: { answered: 3, duringService: 1, whileClosed: 2, minutes: 7, answerMs: { median: 1100, p90: 1600 } },
    };
    await open(page, '/panel/#activity');
    await expect(page.getByRole('heading', { level: 1, name: 'Activité' })).toBeVisible();
    const period = page.getByRole('group', { name: 'Période' });
    await expect(period.getByRole('button', { name: /^7\sjours$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.section__lead')).toHaveText(/^Du samedi 10\soctobre au vendredi 16\soctobre$/);
    const calls = page.getByRole('region', { name: 'Appels', exact: true });
    await expect(calls.locator('.figure')).toHaveText('2');
    await expect(calls.locator('.figure__label')).toHaveText('Appels répondus pendant la fermeture sur 3 appels répondus');
    await expect(page.getByRole('region', { name: 'Délai de réponse' }).locator('.figure')).toHaveText(/^1,1\ss$/);
    await expect(page.getByRole('region', { name: 'Réservations prises' }).locator('.bar__value')).toHaveText(['2', '1', '1', '1']);
    await expectAccessible(page);
    await period.getByRole('button', { name: 'Aujourd’hui' }).click();
    await expect(page.locator('.section__lead')).toHaveText(/^vendredi 16\soctobre$/);
    expect(errors).toEqual([]);
  });

  test('where three columns stand, two short tiles share a cell, and no row waits for a long tile', async ({ page, isMobile }) => {
    test.skip(isMobile, 'A phone has one column.');
    const box = (name: string) => page.getByRole('region', { name, exact: true }).evaluate((tile) => tile.getBoundingClientRect().toJSON() as DOMRect);
    await open(page, '/panel/#activity');
    const calls = await box('Appels');
    expect([(await box('Réservations prises')).top, (await box('Conversations')).top]).toEqual([calls.top, calls.top]);
    expect((await box('Délai de réponse')).top).toBe(calls.bottom + 16);
    await page.locator('.rail a[href$="#settings"]').click();
    const hours = await box('Horaires');
    expect([(await box('Réservations')).top, (await box('Salle')).top]).toEqual([hours.top, hours.top]);
    expect((await box('Langues')).top).toBe(hours.bottom + 16);
  });

  test('Activité with no calls yet says so plainly, without a count out of zero', async ({ page }) => {
    await open(page, '/panel/#activity');
    const calls = page.getByRole('region', { name: 'Appels', exact: true });
    await expect(calls.locator('.figure')).toHaveText('0');
    await expect(calls.locator('.figure__label')).toHaveText('Appels répondus pendant la fermeture');
    await expect(calls.locator('.fact')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Délai de réponse' })).toContainText('Aucun appel sur la période.');
  });

  test('Réglages shows the restaurant as the assistant knows it, its menu’s sheets included', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/#settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
    const hours = page.getByRole('region', { name: 'Horaires' });
    await expect(hours.locator('.fact').first()).toHaveText(/^Lundi\s*Fermé$/);
    await expect(hours).toContainText('Du mardi au samedi');
    await expect(page.getByRole('region', { name: 'Réservations', exact: true })).toContainText(/toutes les 15\smin/);
    // The mousse's sheet says nothing about nuts, and the menu says so, as the assistant does.
    const unstated = dish(page, 'Mousse au chocolat').locator('.dish__line--unknown');
    const more = unstated.getByRole('button', { name: 'voir tous' });
    if ((await more.count()) > 0) await more.click();
    await expect(unstated).toContainText('fruits à coque');
    await expect(page.getByRole('region', { name: 'Infos pratiques' })).toContainText('Où se garer');
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });
});

test.describe('the menu’s sheets in words, as a host reads them on the floor', () => {
  test('each dish reads its sheet exactly as the engine has it, a line per answer', async ({ page }) => {
    await open(page, '/panel/#settings');
    await expect(page.locator('.dish').first()).toBeVisible();
    for (const entry of demo.config.menu) {
      await expect(dish(page, entry.name.fr).locator('.dish__line'), entry.id).toHaveText(sheetOf(entry));
    }
    await expectAccessible(page);
  });

  test('one allergen checked gives each dish its answer for it, the unstated one with what the assistant does', async ({ page }) => {
    await open(page, '/panel/#settings');
    const verdict: Record<AllergenAnswer, string> = {
      contains: '●Contient',
      may_contain: '○Traces',
      free: '·Ne contient pas',
      unknown: '?Non renseigné : l’assistant transmet la question à l’équipe',
    };
    // Every allergen in sight as a chip, one chosen at a time: a radio group, which the arrow keys move through.
    const check = page.getByRole('group', { name: 'Vérifier un allergène' });
    await expect(check.getByRole('radio')).toHaveCount(ALLERGENS.length + 1);
    await expect(check.getByRole('radio', { name: 'Tous' })).toBeChecked();
    await check.getByRole('radio', { name: 'Tous' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(check.getByRole('radio', { name: 'Gluten' })).toBeChecked();
    for (const [allergen, name] of [
      ['gluten', 'Gluten'],
      ['nuts', 'Fruits à coque'],
    ] as const) {
      await check.getByRole('radio', { name }).check();
      for (const entry of demo.config.menu) {
        await expect(dish(page, entry.name.fr).locator('.dish__line'), `${allergen} ${entry.id}`).toHaveText([verdict[allergenStatus(entry, allergen)]]);
      }
    }
    await expectAccessible(page);
    await check.getByRole('radio', { name: 'Tous' }).check();
    await expect(dish(page, 'Mousse au chocolat').locator('.dish__line')).toHaveText(sheetOf(demo.config.menu.find((entry) => entry.id === 'chocolate-mousse')!));
  });
});

test.describe('the controls, drawn as one system', () => {
  test('a select opens its list under itself as one of the panel’s popovers, with its own scroll', async ({ page }) => {
    await open(page, '/panel/');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Nouvelle réservation' }).click();
    const form = page.getByRole('dialog', { name: 'Nouvelle réservation' });
    const time = form.getByRole('combobox', { name: 'Heure' });
    const first = time.getByRole('option').first();
    await expect(first).toBeHidden();
    await time.click();
    await expect(first).toBeVisible();
    const control = await time.boundingBox();
    const option = await first.boundingBox();
    expect(control && option && option.y >= control.y + control.height).toBe(true);
    // Its list is the select's own picker: ten rows at most, then it scrolls.
    expect(await time.evaluate((select) => {
      const picker = getComputedStyle(select, '::picker(select)');
      return [picker.maxHeight, picker.overflowY];
    })).toEqual(['min(360px, max(100% - 8px, 160px))', 'auto']);
    await page.keyboard.press('Escape');
    await expect(first).toBeHidden();
  });

  test('a focused date shows the panel’s grey on its part, or its ring where it is one field, never the system’s blue', async ({ page }) => {
    await open(page, '/panel/');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Nouvelle réservation' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvelle réservation' });
    // The sheet opens on its title, at every size; the keyboard's next stop is the date, on its day.
    await expect(sheet.getByRole('heading', { name: 'Nouvelle réservation' })).toBeFocused();
    await page.keyboard.press('Tab');
    const date = sheet.getByLabel('Date');
    await expect(date).toBeFocused();
    // The day comes first, at the left of the field, where the system drew its blue.
    const box = (await date.boundingBox())!;
    const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: 60, height: box.height }, scale: 'css' });
    const colors = await page.evaluate(async (png) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], { type: 'image/png' }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const { data, width } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const blue = (at: number) => data[at + 2]! > 150 && data[at + 2]! > data[at]! + 60;
      const pixels = { blue: 0, grey: 0 };
      for (let at = 4 * (width + 1); at < data.length - 4 * (width + 1); at += 4) {
        // Blue inside a block of blue, not the coloured edge a desk screen gives its letters.
        if (blue(at) && blue(at - 4) && blue(at + 4) && blue(at - 4 * width) && blue(at + 4 * width)) pixels.blue++;
        if (Math.abs(data[at]! - 74) <= 2 && Math.abs(data[at + 1]! - 75) <= 2 && Math.abs(data[at + 2]! - 77) <= 2) pixels.grey++;
      }
      return pixels;
    }, shot.toString('base64'));
    expect(colors.blue).toBe(0);
    // Where the pointer is a finger the date is one field, as on Android: no part takes the focus, the field takes the
    // panel's ring.
    if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
      const ring = await date.evaluate((field) => {
        const style = getComputedStyle(field);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
      });
      expect(ring).toBe('solid 2px rgb(166, 167, 168)');
    } else {
      expect(colors.grey).toBeGreaterThan(100);
    }
  });

  test('a select low on the screen still opens under itself while four rows fit there, and above only when they do not', async ({ page }) => {
    await open(page, '/panel/#settings');
    await page.locator('#hours-edit').click();
    const select = page.locator('#hours-form select').last();
    // The list opens scrolled to the time chosen, the earlier ones above it out of sight: that one tells where it is.
    const chosen = select.locator('option:checked');
    // Its bottom at that share of the height its scroller shows, and the room the screen leaves it above and below.
    const place = (share: number) =>
      select.evaluate((element, share) => {
        let scroller = element.parentElement;
        while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
        const shown = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
        // On a phone the rail runs along the foot of the screen, over what scrolls.
        const rail = document.querySelector('.rail')?.getBoundingClientRect().top ?? innerHeight;
        const top = Math.max(shown.top, 0);
        const bottom = Math.min(shown.bottom, innerHeight, rail > innerHeight / 2 ? rail : innerHeight);
        (scroller ?? document.scrollingElement!).scrollBy(0, element.getBoundingClientRect().bottom - (top + (bottom - top) * share));
        const box = element.getBoundingClientRect();
        return { above: box.top, below: innerHeight - box.bottom };
      }, share);
    const opens = async () => {
      await select.click();
      await expect(chosen).toBeVisible();
      const control = (await select.boundingBox())!;
      const option = (await chosen.boundingBox())!;
      await page.keyboard.press('Escape');
      await expect(chosen).toBeHidden();
      return option.y >= control.y + control.height ? 'under' : option.y + option.height <= control.y ? 'above' : 'over';
    };

    const room = await place(0.65);
    expect(room.above).toBeGreaterThan(room.below);
    expect(room.below).toBeGreaterThan(4 * 36 + 24);
    expect(await opens()).toBe('under');
    const none = await place(1);
    expect(none.below).toBeLessThan(4 * 36 + 8);
    expect(await opens()).toBe('above');
  });

  test('the keyboard’s ring shows for the keyboard only, the same on the panel and on the site', async ({ page }) => {
    const ring = () =>
      page.evaluate(() => {
        const style = getComputedStyle(document.activeElement!);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`;
      });
    await open(page, '/panel/');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    expect(await ring()).toMatch(/^none /);
    await page.keyboard.press('Tab');
    expect(await ring()).toBe('solid 2px rgb(166, 167, 168) 2px');
    await open(page, '/');
    await page.locator('.site__book').focus();
    await page.keyboard.press('Shift+Tab');
    expect(await ring()).toMatch(/^solid 2px rgb\(95, 95, 95\) (2px|-6px)$/);
  });

  test('on the phone the allergen chips run in one row that scrolls sideways, and the page does not widen', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'A wider screen wraps the chips.');
    await open(page, '/panel/#settings');
    const row = page.getByRole('group', { name: 'Vérifier un allergène' }).locator('.choices');
    await expect(row).toBeVisible();
    const shape = await row.evaluate((element) => ({ scrolls: element.scrollWidth > element.clientWidth, rows: new Set([...element.children].map((chip) => Math.round(chip.getBoundingClientRect().top))).size }));
    expect(shape).toEqual({ scrolls: true, rows: 1 });
    await page.getByRole('radio', { name: 'Mollusques' }).check();
    await expect(page.getByRole('radio', { name: 'Mollusques' }).locator('..')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()?.width);
  });
});

test.describe('a change of language keeps the panel where the visitor is', () => {
  const switchTo = async (page: Page, code: 'fr' | 'en' | 'es', address: RegExp) => {
    await page.locator(`.demo-bar__languages a[hreflang="${code}"]`).click();
    await expect(page).toHaveURL(address);
    await expect(page.locator('html')).toHaveAttribute('lang', code);
  };

  test('the panel opens on the same day, service, way of showing the room, and table', async ({ page, isMobile }) => {
    await open(page, '/panel/');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await expect(page.locator('.day__label')).toHaveText(/^samedi 17\soctobre$/i);
    await page.locator('.services__tab', { hasText: 'Déjeuner' }).click();
    await showPlan(page);
    await page.locator('#table-5').click();
    await expect(page.getByRole('region', { name: /^Table 5/ })).toBeVisible();
    await switchTo(page, 'en', /\/en\/panel\/$/);
    await expect(page.locator('.day__label')).toHaveText(/^Saturday 17\sOctober$/i);
    await expect(page.locator('.services__tab', { hasText: 'Lunch' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: /^Table 5/ })).toBeVisible();
    if (isMobile) await expect(page.getByRole('button', { name: 'Floor plan', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the panel opens on the same section, with the same period, and as far down', async ({ page, isMobile }) => {
    await open(page, '/panel/#activity');
    await page.getByRole('group', { name: 'Période' }).getByRole('button', { name: /^30\sjours$/ }).click();
    await switchTo(page, 'es', /\/es\/panel\/#activity$/);
    await expect(page.getByRole('group', { name: 'Periodo' }).getByRole('button', { name: /^30\sdías$/ })).toHaveAttribute('aria-pressed', 'true');

    await page.locator('.rail a[href$="#settings"]').click();
    await expect(page.locator('.dish').first()).toBeVisible();
    // On a desk the section scrolls on its own, under a bar always in sight. On a phone the page scrolls, and its
    // language links are at its top.
    const body = page.locator('.section__body');
    if (!isMobile) await body.evaluate((section) => section.scrollTo({ top: 500, behavior: 'instant' }));
    await switchTo(page, 'en', /\/en\/panel\/#settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    if (!isMobile) await expect.poll(() => body.evaluate((section) => section.scrollTop)).toBe(500);
  });

  test('on the phone, the conversation open stays open', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Side by side the latest conversation opens on its own.');
    await open(page, '/');
    await openChat(page);
    const chat = page.getByRole('dialog');
    const field = chat.getByRole('textbox', { name: 'Votre message' });
    await chat.getByRole('button', { name: 'Une table demain soir', exact: true }).click();
    await field.press('Enter');
    await expect(chat.locator('.chat__line--agent')).toHaveCount(2);
    await field.fill('Au nom de Lemoine');
    await field.press('Enter');
    const phone = chat.getByRole('textbox', { name: 'Votre numéro de téléphone' });
    await phone.fill('06 39 98 00 21');
    await phone.press('Enter');
    await expect(chat.getByText('Réservation confirmée', { exact: true })).toBeVisible();
    await open(page, '/panel/#conversations');
    await page.getByRole('list', { name: 'Conversations récentes' }).getByRole('button').click();
    await expect(page.locator('.transcript')).toBeVisible();
    await switchTo(page, 'en', /\/en\/panel\/#conversations$/);
    await expect(page.locator('.transcript').getByRole('heading', { level: 2 })).toHaveText('Lemoine');
  });
});

test.describe('the room’s plan, at every width', () => {
  // Every 40 px from 360 to 1920, then phones, tablets either way up, small laptops and desks.
  const SIZES = [
    ...Array.from({ length: (1920 - 360) / 40 + 1 }, (_, index) => [360 + 40 * index, 800] as const),
    ...([[375, 667], [390, 844], [412, 915], [430, 932], [768, 1024], [820, 1180], [834, 1194], [1024, 768], [1024, 1366], [1180, 820], [1194, 834], [1280, 720], [1280, 800], [1366, 768], [1440, 900], [1536, 864], [1680, 1050], [1920, 1080]] as const),
  ];

  /** Each name on the plan against every other name, and against every table but its own. */
  const collisions = (page: Page) =>
    page.locator('.plan').evaluate((plan) => {
      const meets = (one: DOMRect, other: DOMRect) => one.left < other.right && other.left < one.right && one.top < other.bottom && other.top < one.bottom;
      const tables = [...plan.querySelectorAll('.table')];
      const names = tables.flatMap((table) => [...table.querySelectorAll('.table__name')].map((name) => ({ table, text: name.textContent, box: name.getBoundingClientRect() })));
      return names.flatMap((name, index) => [
        ...names.slice(index + 1).filter((other) => meets(name.box, other.box)).map((other) => `${name.text} × ${other.text}`),
        ...tables
          .filter((table) => table !== name.table && meets(name.box, table.querySelector('.table__top')!.getBoundingClientRect()))
          .map((table) => `${name.text} over table ${table.querySelector('.table__top')!.textContent}`),
      ]);
    });

  // At 20:05 the seated tables show a name alone; at 18:30, before dinner, every name carries its time.
  for (const [when, instant] of [
    ['during dinner', null],
    ['before dinner, every name with its time', '2026-10-16T16:30:00.000Z'],
  ] as const) {
    test(`no name runs into another name or another table, ${when}`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'Each size is set here.');
      test.setTimeout(240_000);
      if (instant) {
        demo = new FakeDemo(new Date(instant));
        await demo.install(page);
      }
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        await open(page, '/panel/');
        await showPlan(page);
        await expect(page.locator('.plan .table').first()).toBeVisible();
        expect(await collisions(page), `${width} × ${height}`).toEqual([]);
      }
    });
  }

  test('at a middle width a table’s card stands beside the room, which scrolls to the table chosen', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The phone opens the card over the room.');
    await page.setViewportSize({ width: 1024, height: 768 });
    await open(page, '/panel/');
    // The list and the room take turns, as on the phone.
    await expect(page.locator('.side')).toBeVisible();
    await expect(page.locator('.floor')).toBeHidden();
    await showPlan(page);
    await expect(page.locator('.side')).toBeHidden();
    await page.locator('#table-11').click();
    await expect(page.locator('.card')).toBeVisible();
    // Beside the card the room is wider than its floor: it scrolls, and the table chosen is in sight.
    expect(await page.locator('.floor__scroll').evaluate((floor) => floor.scrollWidth > floor.clientWidth)).toBe(true);
    await expect(page.locator('#table-11')).toBeInViewport({ ratio: 1 });
    expect(await collisions(page)).toEqual([]);
  });
});

test.describe('the owner changes the restaurant’s settings, and the assistant uses them from its next message', () => {
  test('opens Monday’s dinner, at the times dinner keeps on the other days', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/#settings');
    await page.locator('#hours-edit').click();
    const form = page.locator('#hours-form');
    // The keyboard starts in the form, on its first field.
    await expect(form.getByRole('group', { name: 'Lundi' }).getByRole('checkbox', { name: 'déjeuner' })).toBeFocused();
    await form.getByRole('group', { name: 'Lundi' }).getByRole('checkbox', { name: 'dîner' }).check();
    await expect(form.getByRole('group', { name: 'Lundi' }).getByRole('combobox', { name: 'dîner, Première table' })).toHaveValue('19:00');
    await expect(form.getByRole('group', { name: 'Lundi' }).getByRole('combobox', { name: 'dîner, Dernière table' })).toHaveValue('21:30');
    await expectAccessible(page);
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Réglages enregistrés\s: l’assistant s’en sert dès son prochain message\.$/);
    await expect(page.locator('#hours-edit')).toBeFocused();
    const monday = page.getByRole('region', { name: 'Horaires' }).locator('.fact').first();
    await expect(monday).toHaveText(/^Lundi\s*dîner\s: arrivées de 19:00\sà 21:30$/i);
    expect(demo.saved).toEqual([{ weekly: { ...demo.evening.engine.config.weekly, 1: [{ service: 'dinner', firstSeating: '19:00', lastSeating: '21:30' }] } }]);
    expect(errors).toEqual([]);
  });

  test('says a day that cannot stand before anything is sent', async ({ page }) => {
    await open(page, '/panel/#settings');
    await page.locator('#hours-edit').click();
    const tuesday = page.locator('#hours-form').getByRole('group', { name: 'Mardi' });
    await tuesday.getByRole('combobox', { name: 'déjeuner, Dernière table' }).selectOption('11:00');
    await page.locator('#hours-form').getByRole('button', { name: 'Enregistrer' }).click();
    await expect(tuesday.getByText('La dernière table passe avant la première.')).toBeVisible();
    expect(demo.saved).toEqual([]);
    // Cancelled, nothing changed and the button that opened the form has the focus again.
    await page.locator('#hours-form').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.locator('#hours-edit')).toBeFocused();
    expect(demo.saved).toEqual([]);
  });

  test('keeps a dish without its name in the three languages, and brings the problem into sight, said, from the button at the foot', async ({ page }) => {
    await open(page, '/panel/#settings');
    await page.getByRole('button', { name: 'Modifier Mousse au chocolat' }).click();
    const sheet = page.getByRole('dialog', { name: 'Mousse au chocolat' });
    await sheet.getByRole('group', { name: 'Nom du plat' }).getByRole('textbox', { name: 'English' }).fill('');
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    const problem = sheet.getByRole('alert');
    await expect(problem).toHaveText('Le nom s’écrit dans les trois langues.');
    await expect(problem).toBeInViewport();
    expect(demo.saved).toEqual([]);
  });

  test('closes a day for a private event, with the reason the assistant gives in each language', async ({ page }) => {
    await open(page, '/panel/#settings');
    await page.locator('#closures-edit').click();
    const form = page.locator('#closures-form');
    await form.getByLabel('Jour').fill('2026-10-24');
    await form.getByRole('button', { name: 'Ajouter ce jour' }).click();
    const day = form.getByRole('group', { name: /^samedi 24\soctobre$/ });
    await expect(day.getByRole('radio', { name: 'Fermé toute la journée' })).toBeChecked();
    const reason = day.getByRole('group', { name: 'Motif (facultatif)' });
    await reason.getByRole('textbox', { name: 'Français' }).fill('Mariage privé');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    // Half a translation is never sent.
    await expect(day.getByText('Le motif s’écrit dans les trois langues, ou pas du tout.')).toBeVisible();
    expect(demo.saved).toEqual([]);
    await reason.getByRole('textbox', { name: 'English' }).fill('Private wedding');
    await reason.getByRole('textbox', { name: 'Español' }).fill('Boda privada');
    await expectAccessible(page);
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.locator('#closures-edit')).toBeFocused();
    const closure = page.getByRole('region', { name: 'Horaires' }).locator('.fact', { hasText: 'Mariage privé' });
    await expect(closure).toHaveText(/^samedi 24\soctobre\s*Mariage privé\s*Fermé$/);
    expect(demo.saved).toEqual([{ exceptions: [{ date: '2026-10-24', sittings: [], reason: { fr: 'Mariage privé', en: 'Private wedding', es: 'Boda privada' } }] }]);
  });

  test('changes the booking rules, within what the restaurant can take', async ({ page }) => {
    await open(page, '/panel/#settings');
    await page.locator('#rules-edit').click();
    const form = page.locator('#rules-form');
    await form.getByRole('combobox', { name: 'Délai en ligne' }).selectOption('120');
    await form.getByRole('spinbutton', { name: 'Ouverture' }).fill('0');
    // The largest party the tables take online, said where it is chosen.
    await expect(form.getByText(/^Au plus 6\s: le plus grand groupe que vos tables accueillent en ligne\.$/)).toBeVisible();
    await form.getByRole('combobox', { name: 'Groupes' }).selectOption('4');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form.getByText(/^Entre 1 et 730\sjours\.$/)).toBeVisible();
    await form.getByRole('spinbutton', { name: 'Ouverture' }).fill('30');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    const rules = page.getByRole('region', { name: 'Réservations', exact: true });
    await expect(rules).toContainText(/jusqu’à 2\sh avant l’arrivée/);
    await expect(rules).toContainText(/30\sjours à l’avance/);
    await expect(rules).toContainText(/jusqu’à 4\spersonnes en ligne/);
    expect(demo.saved).toEqual([{ minNoticeMinutes: 120, maxAdvanceDays: 30, maxPartySize: 4 }]);
  });

  test('marks the mousse free of nuts, adds a dish to the menu, and takes it off again', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/#settings');
    await page.getByRole('button', { name: 'Modifier Mousse au chocolat' }).click();
    const sheet = page.getByRole('dialog', { name: 'Mousse au chocolat' });
    // Each allergen a row, its four answers one control, which the arrow keys move through.
    const nuts = sheet.getByRole('group', { name: 'fruits à coque' });
    await expect(nuts.getByRole('radio')).toHaveCount(4);
    await expect(nuts.locator('label')).toHaveText(['Contient', 'Traces', 'Ne contient pas', 'Non renseigné']);
    await nuts.getByRole('radio', { name: 'Ne contient pas' }).check();
    await expectAccessible(page);
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Modifier Mousse au chocolat' })).toBeFocused();
    const mousse = demo.config.menu.find((entry) => entry.id === 'chocolate-mousse');
    expect(mousse && allergenStatus(mousse, 'nuts')).toBe('free');
    await expect(dish(page, 'Mousse au chocolat').locator('.dish__line')).toHaveText(sheetOf(mousse!));

    await page.getByRole('button', { name: 'Ajouter un plat' }).click();
    const added = page.getByRole('dialog', { name: 'Ajouter un plat' });
    const name = added.getByRole('group', { name: 'Nom du plat' });
    await name.getByRole('textbox', { name: 'Français' }).fill('Tarte fine aux pommes');
    await name.getByRole('textbox', { name: 'English' }).fill('Thin apple tart');
    await name.getByRole('textbox', { name: 'Español' }).fill('Tarta fina de manzana');
    await added.getByRole('combobox', { name: 'Catégorie' }).selectOption('dessert');
    await added.getByRole('textbox', { name: /^Prix en euros/ }).fill('9,50');
    const gluten = added.getByRole('group', { name: 'gluten' });
    await gluten.getByRole('radio', { name: 'Contient', exact: true }).check();
    await page.keyboard.press('ArrowRight');
    await expect(gluten.getByRole('radio', { name: 'Traces' })).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(gluten.getByRole('radio', { name: 'Contient', exact: true })).toBeChecked();
    await added.getByRole('button', { name: 'Enregistrer' }).click();
    const tart = dish(page, 'Tarte fine aux pommes');
    await expect(tart.locator('.dish__price')).toHaveText(/^9,50\s€$/);
    await expect(tart.locator('.dish__line--contains')).toHaveText(/^.Contient\s: gluten$/);
    // A new dish starts with every other allergen unstated: the line shows the first names, and the rest in place.
    const unstated = tart.locator('.dish__line--unknown');
    await expect(unstated).toHaveText(/^\?Non renseigné \(13\)\s: crustacés, œufs, poisson… voir tous$/);
    await unstated.getByRole('button', { name: 'voir tous' }).click();
    await expect(unstated).toContainText('mollusques');
    await expect(unstated.getByRole('button', { name: 'voir moins' })).toHaveAttribute('aria-expanded', 'true');
    const menu = demo.saved.at(-1)?.['menu'] as { id: string; allergens: Record<string, string>; priceCents: number }[];
    expect(menu.at(-1)).toMatchObject({ id: 'tarte-fine-aux-pommes', priceCents: 950, allergens: { gluten: 'contains' } });

    await page.getByRole('button', { name: 'Modifier Tarte fine aux pommes' }).click();
    const again = page.getByRole('dialog', { name: 'Tarte fine aux pommes' });
    await again.getByRole('button', { name: 'Retirer ce plat' }).click();
    await again.getByRole('button', { name: 'Retirer pour de bon' }).click();
    await expect(tart).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ajouter un plat' })).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('adds a practical answer the assistant gives in each language', async ({ page }) => {
    await open(page, '/panel/#settings');
    await page.locator('#faq-edit').click();
    const form = page.locator('#faq-form');
    await form.getByRole('button', { name: 'Ajouter une question' }).click();
    const entry = form.getByRole('group', { name: 'Question 6' });
    const question = entry.getByRole('group', { name: 'Question', exact: true });
    await question.getByRole('textbox', { name: 'Français' }).fill('Acceptez-vous les chiens ?');
    await question.getByRole('textbox', { name: 'English' }).fill('Are dogs welcome?');
    await question.getByRole('textbox', { name: 'Español' }).fill('¿Se admiten perros?');
    const reply = entry.getByRole('group', { name: 'Réponse' });
    await reply.getByRole('textbox', { name: 'Français' }).fill('Oui, en terrasse.');
    await reply.getByRole('textbox', { name: 'English' }).fill('Yes, on the terrace.');
    await reply.getByRole('textbox', { name: 'Español' }).fill('Sí, en la terraza.');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('region', { name: 'Infos pratiques' })).toContainText('Oui, en terrasse.');
    const faq = demo.saved.at(-1)?.['faq'] as { id: string }[];
    expect(faq.at(-1)?.id).toBe('acceptez-vous-les-chiens');
  });

  test('closing a day that has bookings says whom to call, until each is moved or cancelled', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/#settings');
    await page.locator('#closures-edit').click();
    const form = page.locator('#closures-form');
    // Tonight, with guests still to come.
    await form.getByLabel('Jour').fill('2026-10-16');
    await form.getByRole('button', { name: 'Ajouter ce jour' }).click();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Réglages enregistrés\s: \d+\sréservations tombent en dehors des nouveaux horaires, prévenez ces clients\.$/);
    const notice = page.getByRole('region', { name: /réservations tombent en dehors des horaires$/ });
    // The focus goes to the notice, its top in sight, not back to the button that opened the form.
    await expect(notice.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(notice.getByRole('heading', { level: 2 })).toBeInViewport();
    const roux = notice.getByRole('listitem').filter({ hasText: 'Roux' });
    await expect(roux).toContainText(/Roux, 2\scouverts/);
    await expect(roux.getByRole('link')).toHaveAttribute('href', /^tel:\+/);
    const before = await notice.getByRole('listitem').count();
    await expectAccessible(page);
    await roux.getByRole('button', { name: 'Annuler' }).click();
    await roux.getByRole('button', { name: 'Confirmer l’annulation' }).click();
    await expect(notice.getByRole('listitem')).toHaveCount(before - 1);
    await expect(notice.getByRole('listitem').filter({ hasText: 'Roux' })).toHaveCount(0);
    // The buttons that cancelled went with Roux: the focus waits on the notice, not on the page.
    await expect(notice.getByRole('heading', { level: 2 })).toBeFocused();

    // The service shows them too: tonight is closed now, and its screen lists whom to call instead of a room.
    await page.getByRole('navigation', { name: 'Rubriques' }).getByRole('link', { name: 'Service' }).click();
    await expect(page.getByText('Le restaurant est fermé ce jour-là.')).toBeVisible();
    await expect(page.getByRole('region', { name: /réservations tombent en dehors des horaires$/ }).getByRole('listitem')).toHaveCount(before - 1);
    expect(errors).toEqual([]);
  });

  test('a shortened service badges the bookings it leaves out, and the service says it in one line', async ({ page, isMobile }) => {
    await open(page, '/panel/#settings');
    await page.locator('#closures-edit').click();
    const form = page.locator('#closures-form');
    await form.getByLabel('Jour').fill('2026-10-16');
    await form.getByRole('button', { name: 'Ajouter ce jour' }).click();
    const day = form.getByRole('group', { name: /^vendredi 16\soctobre$/ });
    // A day of its own starts from that weekday's hours: dinner now ends at eight.
    await day.getByRole('radio', { name: 'Horaires particuliers' }).check();
    await day.getByRole('combobox', { name: 'dîner, Dernière table' }).selectOption('20:00');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('status')).toHaveText(/réservations tombent en dehors des nouveaux horaires/);
    await page.getByRole('navigation', { name: 'Rubriques' }).getByRole('link', { name: 'Service' }).click();
    const notice = page.getByRole('region', { name: /réservations tombent en dehors des horaires$/ });
    await expect(notice.getByRole('button', { name: 'Voir' })).toHaveAttribute('aria-expanded', 'false');
    await expect(notice.getByRole('listitem')).toHaveCount(0);
    await notice.getByRole('button', { name: 'Voir' }).click();
    await expect(notice.getByRole('listitem').first()).toBeVisible();
    // The list opens over the room, which keeps its place on the screen, and closes as a menu does.
    expect((await page.locator('.salle').boundingBox())?.height).toBeGreaterThan(200);
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(notice.getByRole('listitem')).toHaveCount(0);
    await expect(notice.getByRole('button', { name: 'Voir' })).toBeFocused();
    if (!isMobile) {
      // Over the room a press elsewhere closes it too. On the phone it opens in the page, which scrolls under the finger.
      await notice.getByRole('button', { name: 'Voir' }).click();
      await page.locator('.status__summary').click();
      await expect(notice.getByRole('button', { name: 'Voir' })).toHaveAttribute('aria-expanded', 'false');
    }
    // Roux comes at 20:30, after dinner's new last table. Girard too, at 21:00: the next party at Martin's table 1.
    await expect(row(page, 'Roux').locator('.pill--outside')).toHaveText('Hors horaires');
    await showPlan(page);
    await page.getByRole('button', { name: /^1, Martin/ }).click();
    const next = page.getByRole('region', { name: /^Table 1, Martin/ }).locator('.card__next');
    await expect(next).toContainText('Girard');
    await expect(next.locator('.pill--outside')).toHaveText('Hors horaires');
    await expectAccessible(page);
  });

  test('says when the restaurant kept nothing, and keeps what was typed', async ({ page }) => {
    demo.refuseSettings = true;
    await open(page, '/panel/#settings');
    await page.locator('#rules-edit').click();
    await page.locator('#rules-form').getByRole('spinbutton', { name: 'Ouverture' }).fill('45');
    await page.locator('#rules-form').getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('alert')).toHaveText(/^Le restaurant n’a pas pu garder ces réglages\s: vérifiez-les et réessayez\.$/);
    await expect(page.locator('#rules-form').getByRole('spinbutton', { name: 'Ouverture' })).toHaveValue('45');
  });

  test('on the recorded evening the settings read, with nothing to edit', async ({ page }) => {
    demo.status = { live: false, calls: null };
    await open(page, '/panel/#settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
    await expect(page.locator('.tile__edit')).toHaveCount(0);
    await expect(page.locator('.dish__edit')).toHaveCount(0);
    await expect(page.locator('.dish').first()).toBeVisible();
  });
});

const SECTIONS_BY_LANGUAGE = [
  { path: '/panel/', rail: 'Rubriques', titles: ['Conversations', 'Activité', 'Réglages'], check: 'Vérifier un allergène' },
  { path: '/en/panel/', rail: 'Sections', titles: ['Conversations', 'Activity', 'Settings'], check: 'Check an allergen' },
  { path: '/es/panel/', rail: 'Secciones', titles: ['Conversaciones', 'Actividad', 'Ajustes'], check: 'Comprobar un alérgeno' },
] as const;

for (const panel of SECTIONS_BY_LANGUAGE) {
  test(`${panel.path} has its sections in its own language, every text set as the copy is, and nothing for axe to report`, async ({ page }) => {
    const errors = watchErrors(page);
    // A call with its turn, and a few days of activity: every kind of figure the sections show.
    demo.calls.push({ sessionId: 'call-a', startedAt: '2026-10-16T17:50:00.000Z', language: 'en', seconds: 192, endedBy: 'goodbye', voiceToVoiceMs: [900, 1100, 1300] });
    demo.turns.push({
      at: '2026-10-16T17:50:20.000Z',
      sessionId: 'call-a',
      channel: 'voice',
      language: 'en',
      guest: 'Do you have a table for four on Saturday at eight?',
      reply: 'I have a table for 4 on Saturday 17 October at 8 pm.',
      outcome: 'answered',
      latencyMs: 2100,
      modelCalls: 2,
      usage: {},
      costUsd: 0.0012,
      tools: [{ name: 'find_table', status: 'available' }],
      corrections: ['guessed_title'],
    });
    demo.activity = {
      bookings: { made: 5, covers: 14, byChannel: { web: 2, whatsapp: 1, voice: 1, staff: 1 } },
      conversations: { written: 3, turns: 11, passedToTeam: 1 },
      calls: { answered: 3, duringService: 1, whileClosed: 2, minutes: 7, answerMs: { median: 1100, p90: 1600 } },
    };
    const [conversations, activity, settings] = panel.titles;
    const rail = page.getByRole('navigation', { name: panel.rail });
    await open(page, `${panel.path}#conversations`);
    await expect(rail.getByRole('link')).toHaveCount(4);
    await expect(page.getByRole('heading', { level: 1, name: conversations })).toBeVisible();
    if (!(await page.locator('.transcript').isVisible())) await page.locator('.talk').first().click();
    await expect(page.locator('.bubble--assistant')).toHaveCount(1);
    // The technical details open too: their words are checked as the thread's are.
    await page.locator('details.tech summary').click();
    expect(await unsetTexts(page)).toEqual([]);
    await expectAccessible(page);
    await rail.getByRole('link', { name: activity }).click();
    await expect(page.getByRole('heading', { level: 1, name: activity })).toBeFocused();
    await expect(page.locator('.figure').first()).toHaveText('2');
    expect(await unsetTexts(page)).toEqual([]);
    await expectAccessible(page);
    await rail.getByRole('link', { name: settings }).click();
    await expect(page.getByRole('heading', { level: 1, name: settings })).toBeFocused();
    await expect(page.getByRole('group', { name: panel.check }).getByRole('radio').first()).toBeChecked();
    expect(await unsetTexts(page)).toEqual([]);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });
}

test.describe('the staff at work, on the French panel', () => {
  test('seat a party waiting at the door', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/');

    await row(page, 'Moreau').click();
    const card = page.getByRole('heading', { name: /^Table \d+, Moreau, 4 couverts$/ });
    await expect(card).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: /^Installer à la table \d+$/ }).click();
    await expect(page.getByRole('status')).toHaveText(/^Moreau\s: à table$/);
    await expect(card).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('seat a walk-in at a table booked later, and let the engine move that booking', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/');
    await showPlan(page);

    await page.getByRole('button', { name: /^4,/ }).click();
    await expect(page.getByRole('heading', { name: 'Table 4, libre' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Ensuite\u202F: Roux à 20:30' })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: '2 personnes', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/^Client sur place\s: à table$/);
    await expect(page.getByRole('button', { name: /^4,/ })).toHaveClass(/is-seated/);
    await expect(page.getByRole('button', { name: /^\d+, Roux 20:30, .*réservation suivante/ })).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('seat a walk-in from the top bar, at the table the engine chooses', async ({ page }) => {
    await open(page, '/panel/');
    const walkIn = page.getByRole('button', { name: 'Sur place', exact: true });
    // Asked and left: Escape closes the sizes and gives the focus back.
    await walkIn.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: /^Client sur place/ })).toHaveCount(0);
    await expect(walkIn).toBeFocused();
    await walkIn.click();
    // Every size the tables take on one row, none left alone on a second.
    const sizes = page.getByRole('group', { name: /^Client sur place/ }).locator('.action--size');
    await expect(sizes).toHaveCount(6);
    expect(new Set(await sizes.evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().top)))).size).toBe(1);
    await page.getByRole('group', { name: /^Client sur place/ }).getByRole('button', { name: '2 personnes', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/^Client sur place\s: table \d+$/);
  });

  test('mark a party that arrives ahead of its time', async ({ page }) => {
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^\d+, Bernard 20:15, / }).click();
    await page.getByRole('group', { name: 'Ensuite\u202F: Bernard à 20:15' }).getByRole('button', { name: 'Marquer l’arrivée' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Bernard\s: arrivée$/);
    await expect(page.getByRole('button', { name: /^Installer à la table \d+$/ })).toBeVisible();
  });

  test('«Visite guidée» in the panel’s bar shows the tour again, from its first step', async ({ page }) => {
    await open(page, '/panel/');
    const tour = page.getByRole('dialog', { name: 'Découvrir le panel' });
    await expect(tour).toHaveCount(0);
    await page.getByRole('button', { name: 'Visite guidée' }).click();
    await expect(tour).toContainText('1 sur 4');
    await expect(tour.getByRole('heading', { name: 'Vous gérez Merrain', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tour).toHaveCount(0);
  });

  test('take a booking by hand, and land on its day and its table', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/panel/');
    await page.getByRole('button', { name: 'Nouvelle réservation' }).click();
    const form = page.getByRole('dialog', { name: 'Nouvelle réservation' });
    // A booking needs a name: the sheet says so in its own words, not the browser's.
    await form.getByRole('button', { name: 'Réserver' }).click();
    await expect(form.getByRole('alert')).toHaveText('Indiquez le nom du client.');
    // A day the restaurant is closed offers no time to book.
    await form.getByLabel('Date').fill('2026-10-19');
    await expect(form.getByText('Le restaurant est fermé ce jour-là.')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Réserver' })).toBeDisabled();
    await form.getByLabel('Date').fill('2026-10-17');
    await form.getByLabel('Heure').selectOption('20:30');
    await form.getByLabel('Couverts').selectOption('4');
    await form.getByLabel('Nom').fill('Garnier');
    await form.getByLabel(/^Téléphone/).fill('06 39 98 00 51');
    // The guest's language starts as the panel's, for what the restaurant sends them later.
    const languages = form.getByRole('group', { name: 'Langue du client' });
    await expect(languages.getByRole('radio', { name: 'Français' })).toBeChecked();
    await languages.getByRole('radio', { name: 'English' }).check();
    // An allergy taken on the phone warns the kitchen as the assistant's do.
    const allergens = form.getByRole('group', { name: 'Allergies' });
    await expect(allergens.getByRole('checkbox')).toHaveCount(14);
    await allergens.getByRole('checkbox', { name: 'lait' }).check();
    await form.getByLabel(/^Notes/).fill('Anniversaire');
    await expectAccessible(page);
    await form.getByRole('button', { name: 'Réserver' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Réservé pour Garnier\s: une table pour 4\spersonnes le samedi 17\soctobre à 20\sh\s30/);
    await expect(page.locator('.day__label')).toHaveText('samedi 17 octobre');
    const card = page.getByRole('region', { name: /^Table \d+/ });
    await expect(card).toContainText('Garnier');
    await expect(card.getByRole('list', { name: 'Allergie' })).toHaveText('lait');
    await expect(card.getByRole('link', { name: '+33 6 39 98 00 51' })).toHaveAttribute('href', 'tel:+33639980051');
    const garnier = demo.evening.engine.serviceDay('2026-10-17', 'fr').bookings.find((booking) => booking.guestName === 'Garnier');
    expect(garnier?.language).toBe('en');
    expect(errors).toEqual([]);
  });

  test('cancel a booking and mark a guest absent, each only after a second step', async ({ page }) => {
    await open(page, '/panel/');
    await showPlan(page);
    // Roux comes at 20:30: not due yet, so it can be cancelled but not marked absent.
    await page.getByRole('button', { name: /^4, Roux 20:30, / }).click();
    const roux = page.getByRole('group', { name: 'Roux, 20:30' });
    await expect(roux.getByRole('button', { name: 'Absent' })).toHaveCount(0);
    await roux.getByRole('button', { name: 'Annuler' }).click();
    await expect(roux.getByRole('button', { name: 'Confirmer l’annulation' })).toBeFocused();
    await expectAccessible(page);
    await roux.getByRole('button', { name: 'Confirmer l’annulation' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Roux\s: annulée$/);

    // Petit was due at 20:00 and has not come: absent, once confirmed.
    // Late, the table is still kept for it: the plan names it first, with how late it is.
    await page.getByRole('button', { name: /^3, Petit, .*de retard/ }).click();
    const petit = page.getByRole('group', { name: 'Petit, 20:00' });
    await petit.getByRole('button', { name: 'Absent' }).click();
    await petit.getByRole('button', { name: 'Retour' }).click();
    await expect(petit.getByRole('button', { name: 'Absent' })).toBeVisible();
    await petit.getByRole('button', { name: 'Absent' }).click();
    await petit.getByRole('button', { name: 'Confirmer l’absence' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Petit\s: absent$/);
  });

  test('«Aujourd’hui» brings the panel back to today from another day', async ({ page }) => {
    await open(page, '/panel/');
    const day = page.locator('.day__label');
    await expect(day).toHaveText(/^vendredi 16\soctobre$/i);
    await expect(page.getByRole('button', { name: 'Aujourd’hui' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await expect(day).toHaveText(/^dimanche 18\soctobre$/i);
    await page.getByRole('button', { name: 'Aujourd’hui' }).click();
    await expect(day).toHaveText(/^vendredi 16\soctobre$/i);
    await expect(page.getByRole('button', { name: 'Aujourd’hui' })).toHaveCount(0);
  });

  test('change a booking, and only what was touched is sent', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/change')) sent.push(request.postDataJSON() as Record<string, unknown>);
    });
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^4, Roux 20:30, / }).click();
    await page.getByRole('region', { name: /^Table 4/ }).getByRole('button', { name: 'Modifier' }).click();
    const sheet = page.getByRole('dialog', { name: 'Modifier la réservation' });
    // The booking as it stands.
    await expect(sheet.getByLabel('Nom')).toHaveValue('Roux');
    await expect(sheet.getByLabel('Heure')).toHaveValue('20:30');
    await expect(sheet.getByLabel('Couverts')).toHaveValue('2');
    await sheet.getByLabel('Heure').selectOption('21:00');
    await sheet.getByLabel('Couverts').selectOption('4');
    await expectAccessible(page);
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Réservation de Roux modifiée\s: une table pour 4\spersonnes/);
    // At 21:00 Roux is due later: the card opens on Roux's new table, Roux named as its next party.
    await expect(page.getByRole('region', { name: /^Table \d+/ })).toContainText('Roux');
    expect(sent).toEqual([{ language: 'fr', time: '21:00', partySize: 4 }]);
  });

  test('nothing touched on a booking, nothing is sent', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/change')) sent.push(request.url());
    });
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^4, Roux 20:30, / }).click();
    await page.getByRole('region', { name: /^Table 4/ }).getByRole('button', { name: 'Modifier' }).click();
    const sheet = page.getByRole('dialog', { name: 'Modifier la réservation' });
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(sheet).toHaveCount(0);
    expect(sent).toEqual([]);
  });

  test('a party already in keeps its day and time, and can still grow, on the tables free for it', async ({ page }) => {
    await open(page, '/panel/');
    await showPlan(page);
    // Martin sits at table 1, a table for two.
    await page.getByRole('button', { name: /^1, Martin/ }).click();
    // Martin's own «Modifier» comes first; Girard's, the next party, is in its group below.
    await page.getByRole('region', { name: /^Table 1, Martin/ }).getByRole('button', { name: 'Modifier' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Modifier la réservation' });
    await expect(sheet.getByLabel('Date')).toBeDisabled();
    await expect(sheet.getByLabel('Heure')).toBeDisabled();
    await expect(sheet.getByText(/^Le client est arrivé\s: la date et l’heure ne changent plus\.$/)).toBeVisible();
    await sheet.getByLabel('Couverts').selectOption('4');
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    // Table 1 no longer seats them: the engine names the tables that would, to choose from.
    const free = sheet.getByRole('group', { name: 'Tables libres' });
    await expect(free.getByRole('button').first()).toBeVisible();
    await expectAccessible(page);
    const choice = (await free.getByRole('button').first().getAttribute('aria-label')) ?? '';
    await free.getByRole('button').first().click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('region', { name: new RegExp(`^${choice}, Martin, 4\\scouverts`) })).toBeVisible();
  });

  test('the booking’s own table, when the engine lists it among the free ones, is named as its current one', async ({ page }) => {
    // The engine lists it after a race: the table the staff chose was taken meanwhile, and its own one was free again.
    await page.route('**/staff/bookings/*/change', (route) => route.fulfill({ status: 409, json: { status: 'table_taken', free: ['4', '5'] } }), { times: 1 });
    const sent: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/change')) sent.push(request.postDataJSON() as Record<string, unknown>);
    });
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^4, Roux 20:30, / }).click();
    await page.getByRole('region', { name: /^Table 4/ }).getByRole('button', { name: 'Modifier' }).click();
    const sheet = page.getByRole('dialog', { name: 'Modifier la réservation' });
    await sheet.getByLabel('Heure').selectOption('21:00');
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    const free = sheet.getByRole('group', { name: 'Tables libres' });
    await expect(free.getByRole('button', { name: 'Table 4 (actuelle)' })).toHaveText(/^4\s\(actuelle\)$/);
    await expect(free.getByRole('button', { name: 'Table 5', exact: true })).toHaveText('5');
    await expectAccessible(page);
    await free.getByRole('button', { name: 'Table 4 (actuelle)' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Réservation de Roux modifiée\s: /);
    expect(sent).toEqual([
      { language: 'fr', time: '21:00' },
      { language: 'fr', time: '21:00', table: '4' },
    ]);
  });

  test('closing a card gives the focus back to the row that opened it, with the list back on a wide screen', async ({ page }) => {
    await open(page, '/panel/');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await row(page, 'Bernard').click();
    const card = page.getByRole('region', { name: /^Table 9/ });
    await expect(card.getByRole('heading', { level: 3 })).toBeFocused();
    // Its way out is at its head, in sight however long the card is.
    await card.locator('.card__head').getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(row(page, 'Bernard')).toBeFocused();

    // Escape closes it too, once what is open over it has closed.
    await row(page, 'Bernard').click();
    await expect(card.getByRole('heading', { level: 3 })).toBeFocused();
    await page.getByRole('button', { name: 'Sur place', exact: true }).click();
    await expect(page.locator('#walk-in-sizes-bar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#walk-in-sizes-bar')).toHaveCount(0);
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(row(page, 'Bernard')).toBeFocused();
    // Pressed the moment the card opens, Escape still finds it listening.
    await row(page, 'Bernard').click();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  });

  test('the next party of a taken table is changed from the table’s card', async ({ page }) => {
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^1, Martin/ }).click();
    const next = page.getByRole('region', { name: /^Table 1, Martin/ }).getByRole('group', { name: /^Ensuite\s: Girard à 21:00$/ });
    await expect(next.getByRole('button', { name: 'Confirmer', exact: true })).toBeVisible();
    await expect(next.getByRole('button', { name: 'Annuler' })).toBeVisible();
    await expectAccessible(page);
    await next.getByRole('button', { name: 'Modifier' }).click();
    await expect(page.getByRole('dialog', { name: 'Modifier la réservation' }).getByLabel('Nom')).toHaveValue('Girard');
  });

  test('a booking later in the evening opens on its table’s card, picked out, with what can be done with it', async ({ page }) => {
    // Friday at 17:30: nobody is in yet, and table 1 has Martin at 19:00, then Girard at 21:00.
    demo = new FakeDemo(new Date('2026-10-16T15:30:00.000Z'));
    await demo.install(page);
    await open(page, '/panel/');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await row(page, 'Girard').click();
    const card = page.getByRole('region', { name: /^Table 1, / });
    await expect(card.getByRole('group', { name: /^Ensuite\s: Martin à 19:00$/ })).toBeVisible();
    const later = card.getByRole('group', { name: 'Plus tard à cette table' });
    const girard = later.getByRole('listitem').filter({ hasText: 'Girard' });
    await expect(girard).toHaveAttribute('aria-current', 'true');
    await expect(girard).toBeInViewport();
    // The row pressed is the booking's own, not the table's other parties: on a wide screen the list waits behind the card.
    await expect(page.locator('.rows .row', { hasText: 'Girard' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.rows .row', { hasText: 'Martin' })).toHaveAttribute('aria-pressed', 'false');
    await expectAccessible(page);
    await girard.getByRole('button', { name: 'Modifier' }).click();
    const sheet = page.getByRole('dialog', { name: 'Modifier la réservation' });
    await expect(sheet.getByLabel('Nom')).toHaveValue('Girard');
    await expect(sheet.getByLabel('Heure')).toHaveValue('21:00');
  });

  test('out of reach in the middle of the service, the panel says so, keeps the service on screen, and acts again once back', async ({ page }) => {
    const errors = watchErrors(page, /\/v1\/demo\/sandboxes\//);
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^9, Bernard 20:15, / }).click();
    const card = page.getByRole('region', { name: /^Table 9/ });
    // The connection drops: nothing the staff do reaches the restaurant, and the screen does not empty.
    await page.route(/\/v1\/demo\/sandboxes\//, (route) => route.abort());
    await card.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/^Le restaurant ne répond pas\s: vérifiez votre connexion\.$/);
    await expect(card).toBeVisible();
    await expect(page.locator('.rows .row').first()).toBeAttached();
    // Back: the same press goes through.
    await page.unroute(/\/v1\/demo\/sandboxes\//);
    await card.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/^Bernard\s: confirmée$/);
    expect(errors).toEqual([]);
  });

  test('confirm a booking «À confirmer» once the guest has said yes', async ({ page }) => {
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^9, Bernard 20:15, / }).click();
    const card = page.getByRole('region', { name: /^Table 9/ });
    await card.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/^Bernard\s: confirmée$/);
    await expect(card.getByRole('button', { name: 'Confirmer', exact: true })).toHaveCount(0);
  });

  test('move a booking to another table, and its card follows it there', async ({ page }) => {
    await open(page, '/panel/');
    await showPlan(page);
    await page.getByRole('button', { name: /^3, Petit, .*de retard/ }).click();
    const card = page.getByRole('region', { name: /^Table 3/ });
    await card.getByRole('button', { name: 'Changer de table' }).click();
    const tables = card.getByRole('group', { name: 'Vers la table' });
    // The tables the engine says would take it for its whole stay, its own left out.
    await expect(tables.getByRole('button', { name: 'Table 5', exact: true })).toBeVisible();
    await expect(tables.getByRole('button', { name: 'Table 3', exact: true })).toHaveCount(0);
    await expectAccessible(page);
    await tables.getByRole('button', { name: 'Table 5', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Petit passe à la table 5.');
    await expect(page.getByRole('region', { name: /^Table 5, Petit/ })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Vers la table' })).toHaveCount(0);
  });

  test('read the requests to call back, and mark one done', async ({ page }) => {
    await open(page, '/panel/');
    const counter = page.getByRole('button', { name: /à rappeler$/ });
    await expect(counter).toHaveText(/^2\sà rappeler$/);
    await counter.click();
    const list = page.getByRole('group', { name: 'À rappeler' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    // The team calls these guests back: the whole number, and a link that dials it.
    const first = list.getByRole('listitem').first();
    const number = (await first.locator('.callback__phone').innerText()).trim();
    expect(number).toMatch(/^\+\d+( \d+)+$/);
    await expect(first.getByRole('link', { name: 'Appeler' })).toHaveAttribute('href', `tel:${number.replaceAll(' ', '')}`);
    await expectAccessible(page);
    await list.getByRole('button', { name: 'Fait' }).first().click();
    await expect(page.getByRole('status')).toHaveText('Demande traitée.');
    await expect(counter).toHaveText(/^1\sà rappeler$/);
    await expect(list.getByRole('listitem')).toHaveCount(1);
    // Over the room, the list closes as a menu does, and the focus goes back to its counter.
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(counter).toBeFocused();
  });

  test('a message goes by itself once it has been read, and stays while the pointer rests on it', async ({ page, isMobile }) => {
    test.skip(isMobile, 'A pointer rests on the message on a desk; on the phone it goes all the same.');
    await page.clock.install();
    await open(page, '/panel/');
    // Cloudflare's check answers on a timer, and the restaurant opens after it.
    await page.clock.runFor(1000);
    await page.getByRole('button', { name: /à rappeler$/ }).click();
    await page.getByRole('group', { name: 'À rappeler' }).getByRole('button', { name: 'Fait' }).first().click();
    const message = page.getByRole('status');
    await expect(message).toHaveText('Demande traitée.');
    await page.locator('.toast__text').hover();
    await page.clock.runFor(15_000);
    await expect(message).toHaveText('Demande traitée.');
    await page.mouse.move(0, 0);
    await page.clock.runFor(11_000);
    await expect(message).toHaveText('');
  });

  test('call a guest from the booking, on their whole number', async ({ page }) => {
    await open(page, '/panel/');
    await row(page, 'Martin').click();
    const phone = page.getByRole('link', { name: /^\+33 6( \d\d){4}$/ });
    await expect(phone).toBeVisible();
    await expect(phone).toHaveAttribute('href', /^tel:\+336\d{8}$/);
  });

  test('find a guest by name, whatever the accents', async ({ page }) => {
    await open(page, '/panel/');
    await page.getByRole('searchbox', { name: 'Rechercher un client' }).fill('lefevre');
    await expect(row(page, 'Lefèvre')).toBeVisible();
    await expect(row(page, 'Moreau')).toHaveCount(0);
  });

  test('read the list grouped as the host does, finished bookings folded away', async ({ page }) => {
    await open(page, '/panel/');
    for (const group of ['Arrivés', 'À venir', 'À table']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${group}`) })).toHaveAttribute('aria-expanded', 'true');
    }
    const finished = page.getByRole('button', { name: /^Terminées ou annulées/ });
    await expect(finished).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('listitem').filter({ hasText: 'Bonnet' })).toBeHidden();
    await finished.click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Bonnet' })).toBeVisible();
  });

  test('look at the days ahead, and find the restaurant closed on Monday', async ({ page }) => {
    await open(page, '/panel/');
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('samedi 17 octobre');
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('lundi 19 octobre');
    await expect(page.getByText('Le restaurant est fermé ce jour-là.')).toBeVisible();
    await expectAccessible(page);
  });

  test('open the covers of the service only when asked', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The phone leaves the covers curve to the desk.');
    await open(page, '/panel/');
    const flow = page.getByRole('img', { name: /^Couverts en salle au fil du service/ });
    await expect(flow).toBeHidden();
    await page.getByText('Couverts au fil du service', { exact: true }).click();
    await expect(flow).toBeVisible();
  });
});

test.describe('the frame of the demo: the bar, the browser tab, and what a shared link shows', () => {
  /** The frames of an icon file, by their side in pixels, as the file's own directory lists them. */
  const icoFrames = (file: Buffer) =>
    new Map(
      Array.from({ length: file.readUInt16LE(4) }, (_, index) => {
        const entry = 6 + 16 * index;
        const offset = file.readUInt32LE(entry + 12);
        return [file.readUInt8(entry) || 256, file.subarray(offset, offset + file.readUInt32LE(entry + 8))] as const;
      }),
    );
  const HEADS = [
    { path: '/', title: 'Maître | assistant de réservation pour restaurants', indexed: true },
    { path: '/en/', title: 'Maître | booking assistant for restaurants', indexed: true },
    { path: '/es/', title: 'Maître | asistente de reservas para restaurantes', indexed: true },
    { path: '/panel/', title: 'Maître | panel du restaurant', indexed: false },
    { path: '/en/panel/', title: 'Maître | restaurant panel', indexed: false },
    { path: '/es/panel/', title: 'Maître | panel del restaurante', indexed: false },
    { path: '/mentions-legales/', title: 'Mentions légales et confidentialité | Maître', indexed: true },
    { path: '/en/legal/', title: 'Legal notice and privacy | Maître', indexed: true },
    { path: '/es/aviso-legal/', title: 'Aviso legal y privacidad | Maître', indexed: true },
    { path: '/404.html', title: 'Page introuvable | Maître', indexed: false },
  ] as const;

  for (const head of HEADS) {
    test(`${head.path} names the product in its tab and in a shared link, and the invented bistro only inside`, async ({ page }) => {
      await page.goto(head.path);
      await expect(page).toHaveTitle(head.title);
      const meta = (selector: string) => page.locator(selector).first().getAttribute('content');
      expect(await meta('meta[property="og:title"]')).toBe(head.title);
      expect(await meta('meta[property="og:site_name"]')).toBe('Maître');
      const description = (await meta('meta[name="description"]')) ?? '';
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(160);
      expect(await meta('meta[property="og:description"]')).toBe(description);
      expect(await meta('meta[property="og:image"]')).toMatch(/^https:\/\/maitre\.live\/og\/maitre-(fr|en|es)\.jpg$/);
      // An indexed page names its address and its other languages; the panel and the 404 are kept out of search.
      if (head.indexed) {
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new URL(head.path, 'https://maitre.live').href);
        await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(4);
        await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
      } else {
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
      }
      // The tab's icon, first after the charset and the viewport, written into the page: Edge has it as the head
      // starts, with nothing to fetch. Migue Studio's own frames byte for byte as in its favicon.ico, then its 96 px file.
      await expect(page.locator('link[rel="icon"]')).toHaveCount(3);
      const icons = await page.evaluate(() =>
        [...document.head.children].slice(2, 5).map((link) => ['rel', 'type', 'sizes', 'href'].map((name) => link.getAttribute(name)).join(' ')),
      );
      const frames = icoFrames(await (await page.request.get('/favicon.ico')).body());
      expect(icons).toEqual([
        ...[32, 16].map((side) => {
          const frame = frames.get(side)!;
          // A PNG gives its width and height in its header.
          expect([frame.readUInt32BE(16), frame.readUInt32BE(20)]).toEqual([side, side]);
          return `icon image/png ${side}x${side} data:image/png;base64,${frame.toString('base64')}`;
        }),
        'icon image/png 96x96 /favicon-96x96.png',
      ]);
      await expect(page.locator('link[rel="apple-touch-icon"][sizes="180x180"]')).toHaveAttribute('href', '/apple-icon.png');
    });
  }

  test('the icons a browser asks for are there: Migue Studio’s own, byte for byte', async ({ page }) => {
    // The one a browser asks for on its own, the one the pages link for search engines, and a phone's home screen's.
    // Each is pinned to the file Migue Studio publishes, by its SHA-256.
    for (const [path, type, digest] of [
      ['/favicon.ico', /^image\/(x-icon|vnd\.microsoft\.icon)$/, '8980dc73a6e6805b1bce1967da9cdb98879317fd89e59c760dce6a50dce32545'],
      ['/favicon-96x96.png', /^image\/png$/, 'f434505f55dffee111fd3031fe62413518ab54522c2c7ac9679816292d31adb4'],
      ['/apple-icon.png', /^image\/png$/, '4441806db161aba7e97ab986ce4f0ab825d62aa32891f4a2076ba77faaa9e4fb'],
    ] as const) {
      const answer = await page.request.get(path);
      expect(answer.status(), path).toBe(200);
      expect(answer.headers()['content-type'] ?? '', path).toMatch(type);
      expect(createHash('sha256').update(await answer.body()).digest('hex'), path).toBe(digest);
    }
  });

  test('the bar shows who made the product and what it is, and links to the studio in a new tab', async ({ page, isMobile }) => {
    await open(page, '/en/');
    const bar = page.getByRole('complementary', { name: 'Maître demo' });
    const studio = bar.getByRole('link', { name: 'Migue Studio', exact: true });
    await expect(studio).toHaveAttribute('href', 'https://miguestudio.me');
    await expect(studio).toHaveAttribute('target', '_blank');
    await expect(studio).toHaveAttribute('rel', /noopener/);
    // Its own mark, loaded, in a size for each screen density.
    const mark = studio.locator('img');
    await expect(mark).toBeVisible();
    expect(await mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(mark).toHaveAttribute('srcset', /\s2x$/);
    await expect(bar.getByRole('link', { name: 'Maître', exact: true })).toBeVisible();
    // What it is, on a wide screen only: the phone keeps the bar to the mark and the name.
    const product = bar.locator('.demo-bar__what');
    await expect(product).toHaveText('booking assistant for restaurants');
    if (isMobile) await expect(product).toBeHidden();
    else await expect(product).toBeVisible();
    await expectAccessible(page);
  });

  test('the bar keeps the height of the window it is in, through a resize either way', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The window is resized by hand here.');
    const heights = () =>
      page.evaluate(() => ({ bar: document.querySelector<HTMLElement>('.demo-bar')!.offsetHeight, measured: getComputedStyle(document.documentElement).getPropertyValue('--bar-h').trim() }));
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/es/');
    const phone = await heights();
    expect(phone.bar).toBeGreaterThan(36);
    expect(phone.measured).toBe(`${phone.bar}px`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(heights).toEqual({ bar: 36, measured: '36px' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(heights).toEqual(phone);
  });

  test('the top controls stand as far from the bar as from the side, the menu’s cross where its lines were', async ({ page, isMobile }) => {
    await open(page, '/');
    const inset = isMobile ? 8 : 12;
    const bar = await page.locator('.demo-bar').boundingBox();
    const toggle = await page.locator('.site__toggle').boundingBox();
    const tabs = await page.locator('.site__tabs').boundingBox();
    const tab = await page.locator('.site__book').boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(bar && toggle && tabs && tab).toBeTruthy();
    if (!bar || !toggle || !tabs || !tab) return;
    expect(Math.round(toggle.y - (bar.y + bar.height))).toBe(inset);
    expect(Math.round(toggle.x)).toBe(inset);
    expect(Math.round(tabs.y - (bar.y + bar.height))).toBe(inset);
    expect(Math.round(width - (tabs.x + tabs.width))).toBe(inset);
    expect([Math.round(toggle.height), Math.round(tab.height)]).toEqual([44, 44]);
    await page.locator('.site__toggle').click();
    const cross = await page.getByRole('button', { name: 'Fermer', exact: true }).boundingBox();
    expect(cross && [cross.x, cross.y].map(Math.round)).toEqual([toggle.x, toggle.y].map(Math.round));
  });
});
