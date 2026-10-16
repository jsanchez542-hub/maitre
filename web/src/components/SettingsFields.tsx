import { LANGUAGES, localize, toMinutes, type Language, type LocalizedText, type PlainTime, type ServiceDefinition, type Sitting } from 'maitre';
import type { Messages } from '../i18n/messages';
import { LANGUAGE_NAMES } from '../i18n/routes';

interface SittingsProps {
  services: readonly ServiceDefinition[];
  sittings: readonly Sitting[];
  times: readonly PlainTime[];
  language: Language;
  s: Messages['panel']['settings'];
  /** The times a service takes when it is opened on this day: those it keeps on other days. */
  usual: (service: string) => Sitting;
  onChange: (sittings: Sitting[]) => void;
}

/** One day's services, each open or not, between its first and its last table. */
export function SittingsFields({ services, sittings, times, language, s, usual, onChange }: SittingsProps) {
  const put = (next: Sitting[]) => onChange([...next].sort((a, b) => toMinutes(a.firstSeating) - toMinutes(b.firstSeating)));
  const toggle = (service: string) =>
    put(sittings.some((sitting) => sitting.service === service) ? sittings.filter((sitting) => sitting.service !== service) : [...sittings, usual(service)]);
  const change = (service: string, field: 'firstSeating' | 'lastSeating', time: PlainTime) =>
    put(sittings.map((sitting) => (sitting.service === service ? { ...sitting, [field]: time } : sitting)));

  return (
    <div class="sittings-edit">
      {services.map((service) => {
        const sitting = sittings.find((candidate) => candidate.service === service.id);
        const name = localize(service.name, language);
        return (
          <div class="sitting-edit" key={service.id}>
            <label class="sitting-edit__open">
              <input type="checkbox" checked={sitting !== undefined} onChange={() => toggle(service.id)} />
              <span class="sitting-edit__name">{name}</span>
            </label>
            {sitting && (
              <>
                <label class="field">
                  <span class="field__label">
                    <span class="sr-only">{`${name}, `}</span>
                    {s.firstTable}
                  </span>
                  <select value={sitting.firstSeating} onInput={(event) => change(service.id, 'firstSeating', event.currentTarget.value)}>
                    {times.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">
                    <span class="sr-only">{`${name}, `}</span>
                    {s.lastTable}
                  </span>
                  <select value={sitting.lastSeating} onInput={(event) => change(service.id, 'lastSeating', event.currentTarget.value)}>
                    {times.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A text the assistant says in each language it speaks: one field per language, named in that language. */
export function TrilingualFields({
  legend,
  value,
  multiline = false,
  onChange,
}: {
  legend: string;
  value: LocalizedText;
  multiline?: boolean;
  onChange: (value: LocalizedText) => void;
}) {
  return (
    <fieldset class="trilingual">
      <legend class="field__label">{legend}</legend>
      {LANGUAGES.map((language) => (
        <label class="field" key={language}>
          <span class="field__label" lang={language}>
            {LANGUAGE_NAMES[language]}
          </span>
          {multiline ? (
            <textarea rows={2} maxLength={400} lang={language} value={value[language]} onInput={(event) => onChange({ ...value, [language]: event.currentTarget.value })} />
          ) : (
            <input type="text" maxLength={80} lang={language} value={value[language]} onInput={(event) => onChange({ ...value, [language]: event.currentTarget.value })} />
          )}
        </label>
      ))}
    </fieldset>
  );
}

/** Whether a text is written in every language, or in none: half a translation is never sent. */
export function writtenIn(text: LocalizedText): 'all' | 'none' | 'some' {
  const filled = LANGUAGES.filter((language) => text[language].trim() !== '').length;
  return filled === LANGUAGES.length ? 'all' : filled === 0 ? 'none' : 'some';
}

export const blankText = (): LocalizedText => ({ fr: '', en: '', es: '' });

export const trimmedText = (text: LocalizedText): LocalizedText => ({ fr: text.fr.trim(), en: text.en.trim(), es: text.es.trim() });

/** Save and cancel, and why the restaurant kept nothing when it did not. */
export function EditActions({ s, busy, refused, onCancel }: { s: Messages['panel']['settings']; busy: boolean; refused: boolean; onCancel: () => void }) {
  return (
    <>
      {refused && (
        <p class="edit__problem" role="alert">
          {s.refused}
        </p>
      )}
      <div class="edit__actions">
        <button type="submit" class="action action--primary" disabled={busy}>
          {s.save}
        </button>
        <button type="button" class="action action--quiet" onClick={onCancel}>
          {s.cancel}
        </button>
      </div>
    </>
  );
}
