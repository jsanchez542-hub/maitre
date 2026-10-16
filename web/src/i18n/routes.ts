import type { Language } from 'maitre';

/** French is the default language and has no prefix, as astro.config.mjs sets it. */
export const HOME: Record<Language, string> = { fr: '/', en: '/en/', es: '/es/' };

export const PANEL: Record<Language, string> = { fr: '/panel/', en: '/en/panel/', es: '/es/panel/' };

export const LEGAL: Record<Language, string> = { fr: '/mentions-legales/', en: '/en/legal/', es: '/es/aviso-legal/' };

/** Each language named in itself, so visitors find theirs whatever page they are on. */
export const LANGUAGE_NAMES: Record<Language, string> = { fr: 'Français', en: 'English', es: 'Español' };
