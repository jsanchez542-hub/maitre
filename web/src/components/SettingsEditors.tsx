import { formatDate, isoWeekday, type LocalizedText, type PlainDate, type Sitting, type Weekday } from 'maitre';
import { useState } from 'preact/hooks';
import { largestParty, idFor, sittingsProblem, timesOfDay, usualSitting, type EditableSettings } from '../lib/settings';
import { typeset } from '../lib/typography';
import type { PanelApp } from './Panel';
import { blankText, EditActions, SittingsFields, TrilingualFields, trimmedText, writtenIn } from './SettingsFields';

export interface EditorProps {
  app: PanelApp;
  /** Sends the changes: true once the restaurant has kept them. */
  save: (changes: EditableSettings) => Promise<boolean>;
  /** The restaurant kept nothing of the last try. */
  refused: boolean;
  onCancel: () => void;
}

const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/** Sends once every field holds, and says busy until the restaurant answers. */
export function useSubmit(save: EditorProps['save']) {
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event, holds: boolean, changes: () => EditableSettings) => {
    event.preventDefault();
    setTried(true);
    if (!holds) {
      // The problems are written with the next render: the first is brought into sight, where the owner reads it.
      const form = event.currentTarget;
      if (form instanceof HTMLFormElement) requestAnimationFrame(() => form.querySelector('.edit__problem')?.scrollIntoView({ block: 'center' }));
      return;
    }
    if (busy) return;
    setBusy(true);
    await save(changes());
    setBusy(false);
  };
  return { tried, busy, submit };
}

/** The week's hours: for each day, each service open or not, from its first table to its last. */
export function HoursEditor({ app, save, refused, onCancel }: EditorProps) {
  const { t, language, config } = app;
  const s = t.panel.settings;
  const [weekly, setWeekly] = useState<Record<Weekday, readonly Sitting[]>>(() => ({ ...config.weekly }));
  const { tried, busy, submit } = useSubmit(save);
  const times = timesOfDay(config.slotMinutes);
  const problems = WEEKDAYS.map((day) => sittingsProblem(weekly[day]));

  return (
    <form class="edit" noValidate onSubmit={(event) => void submit(event, problems.every((problem) => problem === null), () => ({ weekly }))}>
      {WEEKDAYS.map((day, index) => (
        <fieldset class="edit__day" key={day}>
          <legend class="edit__legend">{t.site.weekdays[day - 1]}</legend>
          <SittingsFields
            services={config.services}
            sittings={weekly[day]}
            times={times}
            language={language}
            s={s}
            usual={(service) => usualSitting(config, service)}
            onChange={(sittings) => setWeekly({ ...weekly, [day]: sittings })}
          />
          {tried && problems[index] && <p class="edit__problem" role="alert">{problems[index] === 'order' ? s.order : s.overlap}</p>}
        </fieldset>
      ))}
      <EditActions s={s} busy={busy} refused={refused} onCancel={onCancel} />
    </form>
  );
}

interface Closure {
  date: PlainDate;
  /** Open on hours of its own; otherwise closed all day. */
  special: boolean;
  sittings: readonly Sitting[];
  reason: LocalizedText;
}

/** Closures and days with hours of their own: the assistant says them to whoever asks for that day. */
export function ClosuresEditor({ app, save, refused, onCancel }: EditorProps) {
  const { t, language, config, snapshot } = app;
  const s = t.panel.settings;
  const [days, setDays] = useState<Closure[]>(() =>
    config.exceptions.map((day) => ({ date: day.date, special: day.sittings.length > 0, sittings: day.sittings, reason: day.reason ?? blankText() })),
  );
  const [adding, setAdding] = useState('');
  const [taken, setTaken] = useState(false);
  const { tried, busy, submit } = useSubmit(save);
  const times = timesOfDay(config.slotMinutes);
  const problems = days.map((day) => (day.special && sittingsProblem(day.sittings)) || (writtenIn(day.reason) === 'some' ? 'reason' : null));
  const update = (index: number, change: Partial<Closure>) => setDays(days.map((day, at) => (at === index ? { ...day, ...change } : day)));
  const add = () => {
    if (!adding) return;
    if (days.some((day) => day.date === adding)) {
      setTaken(true);
      return;
    }
    setTaken(false);
    setDays([...days, { date: adding, special: false, sittings: [], reason: blankText() }].sort((a, b) => a.date.localeCompare(b.date)));
    setAdding('');
  };
  const exceptions = () =>
    days.map((day) => ({
      date: day.date,
      sittings: day.special ? day.sittings : [],
      ...(writtenIn(day.reason) === 'all' ? { reason: trimmedText(day.reason) } : {}),
    }));

  return (
    <form class="edit" noValidate onSubmit={(event) => void submit(event, problems.every((problem) => problem === null), () => ({ exceptions: exceptions() }))}>
      {days.length === 0 && <p class="tile__help">{s.noExceptions}</p>}
      {days.map((day, index) => {
        const problem = problems[index];
        return (
          <fieldset class="edit__day" key={day.date}>
            <legend class="edit__legend">{typeset(formatDate(day.date, language, snapshot.today))}</legend>
            <div class="choices">
              <label class="choice">
                <input type="radio" name={`closure-${day.date}`} checked={!day.special} onChange={() => update(index, { special: false })} />
                {s.closedAllDay}
              </label>
              <label class="choice">
                <input
                  type="radio"
                  name={`closure-${day.date}`}
                  checked={day.special}
                  // A day of its own starts from that weekday's usual hours, which the owner then changes.
                  onChange={() => update(index, { special: true, sittings: day.sittings.length > 0 ? day.sittings : config.weekly[isoWeekday(day.date)] })}
                />
                {s.specialHours}
              </label>
            </div>
            {day.special && (
              <SittingsFields
                services={config.services}
                sittings={day.sittings}
                times={times}
                language={language}
                s={s}
                usual={(service) => usualSitting(config, service)}
                onChange={(sittings) => update(index, { sittings })}
              />
            )}
            <TrilingualFields legend={`${s.reason} (${t.panel.booking.optional})`} value={day.reason} onChange={(reason) => update(index, { reason })} />
            {tried && problem && <p class="edit__problem" role="alert">{problem === 'reason' ? s.reasonIncomplete : problem === 'order' ? s.order : s.overlap}</p>}
            <button type="button" class="action action--quiet edit__remove" onClick={() => setDays(days.filter((_, at) => at !== index))}>
              {s.remove}
            </button>
          </fieldset>
        );
      })}
      <div class="edit__add">
        <label class="field">
          <span class="field__label">{s.day}</span>
          <input type="date" min={snapshot.today} value={adding} onInput={(event) => setAdding(event.currentTarget.value)} />
        </label>
        <button type="button" class="action" onClick={add}>
          {s.addDay}
        </button>
      </div>
      {taken && <p class="edit__problem" role="alert">{s.dayTaken}</p>}
      <EditActions s={s} busy={busy} refused={refused} onCancel={onCancel} />
    </form>
  );
}

/** The notices the restaurant can ask for, from none to two days: the rule an owner picks from, not types. */
const NOTICE_MINUTES = [0, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880];

/** The rules a guest books under online: how late, how far ahead, and the largest party. */
export function RulesEditor({ app, save, refused, onCancel }: EditorProps) {
  const { t, config } = app;
  const s = t.panel.settings;
  const largest = largestParty(config);
  const [notice, setNotice] = useState(config.minNoticeMinutes);
  const [advance, setAdvance] = useState(String(config.maxAdvanceDays));
  const [party, setParty] = useState(config.maxPartySize);
  const { tried, busy, submit } = useSubmit(save);
  const days = Number(advance);
  const advanceHolds = Number.isInteger(days) && days >= 1 && days <= 730;
  const notices = [...new Set([...NOTICE_MINUTES, config.minNoticeMinutes])].sort((a, b) => a - b);

  return (
    <form class="edit" noValidate onSubmit={(event) => void submit(event, advanceHolds, () => ({ minNoticeMinutes: notice, maxAdvanceDays: days, maxPartySize: party }))}>
      <label class="field">
        <span class="field__label">{s.notice}</span>
        <select value={notice} onInput={(event) => setNotice(Number(event.currentTarget.value))}>
          {notices.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? s.noticeNone : typeset(s.noticeValue(minutes))}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="field__label">{s.advance}</span>
        <span class="field__unit">
          <input type="number" min={1} max={730} inputMode="numeric" required value={advance} onInput={(event) => setAdvance(event.currentTarget.value)} />
          <span>{s.advanceUnit}</span>
        </span>
      </label>
      {tried && !advanceHolds && <p class="edit__problem" role="alert">{s.advanceRange}</p>}
      <label class="field">
        <span class="field__label">{s.party}</span>
        <select value={party} onInput={(event) => setParty(Number(event.currentTarget.value))}>
          {Array.from({ length: Math.max(largest, config.maxPartySize) }, (_, index) => index + 1).map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span class="field__help">{s.partyHelp(largest)}</span>
      </label>
      <EditActions s={s} busy={busy} refused={refused} onCancel={onCancel} />
    </form>
  );
}

interface Answer {
  /** Kept when the answer is edited, as the assistant knows it by it; a new one gets its id when it is sent. */
  id: string | null;
  question: LocalizedText;
  answer: LocalizedText;
}

/** The practical answers the assistant gives as they are written: parking, terrace, children. */
export function AnswersEditor({ app, save, refused, onCancel }: EditorProps) {
  const { t, config } = app;
  const s = t.panel.settings;
  const [entries, setEntries] = useState<Answer[]>(() => config.faq.map((entry) => ({ id: entry.id, question: entry.question, answer: entry.answer })));
  const { tried, busy, submit } = useSubmit(save);
  const complete = entries.map((entry) => writtenIn(entry.question) === 'all' && writtenIn(entry.answer) === 'all');
  const update = (index: number, change: Partial<Answer>) => setEntries(entries.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));
  const faq = () => {
    const taken = new Set(entries.flatMap((entry) => (entry.id ? [entry.id] : [])));
    return entries.map((entry) => {
      const id = entry.id ?? idFor(entry.question.fr, taken, 'answer');
      taken.add(id);
      return { id, question: trimmedText(entry.question), answer: trimmedText(entry.answer) };
    });
  };

  return (
    <form class="edit" noValidate onSubmit={(event) => void submit(event, complete.every(Boolean), () => ({ faq: faq() }))}>
      {entries.map((entry, index) => (
        <fieldset class="edit__day" key={entry.id ?? `new-${index}`}>
          <legend class="edit__legend">{`${s.question} ${index + 1}`}</legend>
          <TrilingualFields legend={s.question} value={entry.question} onChange={(question) => update(index, { question })} />
          <TrilingualFields legend={s.answer} value={entry.answer} multiline onChange={(answer) => update(index, { answer })} />
          {tried && !complete[index] && <p class="edit__problem" role="alert">{s.textMissing}</p>}
          <button type="button" class="action action--quiet edit__remove" onClick={() => setEntries(entries.filter((_, at) => at !== index))}>
            {s.remove}
          </button>
        </fieldset>
      ))}
      <div class="edit__add">
        <button type="button" class="action" onClick={() => setEntries([...entries, { id: null, question: blankText(), answer: blankText() }])}>
          {s.addQuestion}
        </button>
      </div>
      <EditActions s={s} busy={busy} refused={refused} onCancel={onCancel} />
    </form>
  );
}
