import type { Messages } from '../i18n/messages';
import { Icon, type IconName } from './Icons';

export const SECTIONS = ['service', 'conversations', 'activity', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];

export const isSection = (value: string): value is Section => (SECTIONS as readonly string[]).includes(value);

const ICONS: Record<Section, IconName> = { service: 'floor', conversations: 'chat', activity: 'chart', settings: 'sliders' };

/**
 * The panel's sections down the side, the settings at the foot; on the phone, a bar along
 * the bottom. Links, so each section has its address and the browser's back button goes where it went.
 */
export function Rail({ t, sections, current }: { t: Messages['panel']['sections']; sections: readonly Section[]; current: Section }) {
  return (
    <nav class="rail" aria-label={t.label}>
      <ul class="rail__list">
        {sections.map((section) => (
          <li key={section} class={`rail__item rail__item--${section}`}>
            <a class="rail__link" href={`#${section}`} aria-current={section === current ? 'page' : undefined}>
              <Icon name={ICONS[section]} />
              <span class="rail__label">{t[section]}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
