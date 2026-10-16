import type { Language } from 'maitre';
import { LiveError, openSandbox } from './live';
import { currentSandbox, keepSandbox, type StoredSandbox } from './sandbox';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      language: Language;
      appearance: 'interaction-only';
      theme: 'light' | 'dark';
      callback: (token: string) => void;
      'error-callback': () => boolean;
      'timeout-callback': () => void;
      'before-interactive-callback': () => void;
      'after-interactive-callback': () => void;
    },
  ): string | undefined;
  remove(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.addEventListener('load', () => (window.turnstile ? resolve(window.turnstile) : reject(new LiveError('turnstile_failed'))));
    script.addEventListener('error', () => {
      // A network that dropped the script can try again on the next attempt.
      loading = undefined;
      script.remove();
      reject(new LiveError('offline'));
    });
    document.head.append(script);
  });
  return loading;
}

export interface Verification {
  /** Where Cloudflare draws its check, when it needs the visitor to click. */
  container: HTMLElement;
  siteKey: string | undefined;
  language: Language;
  theme: 'light' | 'dark';
  /** Called with true while the check waits for the visitor, and false once it no longer does. */
  onInteractive: (waiting: boolean) => void;
}

/** Cloudflare's check that a person is there, in managed mode: most visitors never see it. */
async function provePerson({ container, siteKey, language, theme, onInteractive }: Verification & { siteKey: string }): Promise<string> {
  const turnstile = await loadTurnstile();
  return new Promise((resolve, reject) => {
    let widget: string | undefined;
    const settle = (finish: () => void) => {
      onInteractive(false);
      // Removed after the callback returns: Turnstile is still inside its own call.
      setTimeout(() => widget !== undefined && turnstile.remove(widget));
      finish();
    };
    widget = turnstile.render(container, {
      sitekey: siteKey,
      language,
      appearance: 'interaction-only',
      theme,
      callback: (token) => settle(() => resolve(token)),
      'error-callback': () => {
        settle(() => reject(new LiveError('turnstile_failed')));
        return true;
      },
      'timeout-callback': () => settle(() => reject(new LiveError('turnstile_failed'))),
      'before-interactive-callback': () => onInteractive(true),
      'after-interactive-callback': () => onInteractive(false),
    });
  });
}

/** The visitor's own restaurant: the one kept in the browser, or a new one once Turnstile has vouched for them. */
export async function connect(verification: Verification): Promise<StoredSandbox> {
  const kept = currentSandbox();
  if (kept) return kept;
  const { siteKey } = verification;
  // Without a site key the build has no live demo: the page says so and plays the recordings.
  if (!siteKey) throw new LiveError('not_configured');
  const token = await provePerson({ ...verification, siteKey });
  return keepSandbox(await openSandbox(token, verification.language));
}
