import { ALLERGENS, allergenStatus, formatDate, localize, type Dish, type Sitting, type StaffBookingView } from 'maitre';
import { useState } from 'preact/hooks';
import { serviceName, weekOf } from '../lib/restaurant';
import { problemsWith, type EditableSettings } from '../lib/settings';
import { typeset } from '../lib/typography';
import { BookingSheet } from './BookingSheet';
import { DishEditor } from './DishEditor';
import { MenuSheet } from './MenuSheet';
import { OutsideHours } from './OutsideHours';
import type { PanelApp } from './Panel';
import { SectionBar } from './PanelBar';
import { AnswersEditor, ClosuresEditor, HoursEditor, RulesEditor } from './SettingsEditors';

/** The parts an owner edits, one at a time. */
type Part = 'hours' | 'closures' | 'rules' | 'menu' | 'faq';

/** The first field of a form that has just opened, so the keyboard starts where the owner is about to type. */
const FIELDS = 'input:not([type="hidden"]), select, textarea';

/**
 * The restaurant's settings as the assistant and the engine use them: the hours, the closures, the booking rules,
 * the room, the languages, the allergen table and the practical answers. Read from the restaurant itself, so what
 * shows here is what the assistant answers with; its owner changes them here, and the assistant uses them from its
 * next message. The tables and the plan stay as they are: bookings sit on them.
 */
export function SettingsView({ app }: { app: PanelApp }) {
  const { t, language, snapshot, config, notify } = app;
  const s = t.panel.settings;
  const site = t.site;
  const [editing, setEditing] = useState<Part | null>(null);
  const [dish, setDish] = useState<Dish | 'new' | null>(null);
  const [refused, setRefused] = useState<Part | null>(null);
  // A booking the hours leave out, opened from the notice to move it back into them.
  const [moving, setMoving] = useState<StaffBookingView | null>(null);
  const canEdit = app.saveSettings !== null && editing === null && dish === null;

  const open = (part: Part) => {
    setRefused(null);
    setEditing(part);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`#${part}-form ${FIELDS}`)?.focus());
  };
  /** Back to the settings as they read: the focus returns to what opened the form, or to its part's button once a dish has gone. */
  const close = (part: Part, opener = `${part}-edit`) => {
    setEditing(null);
    setDish(null);
    setRefused(null);
    requestAnimationFrame(() => (document.getElementById(opener) ?? document.getElementById(`${part}-edit`))?.focus());
  };
  const save =
    (part: Part, opener?: string) =>
    async (changes: EditableSettings): Promise<boolean> => {
      setRefused(null);
      // Nothing the restaurant would refuse is sent: the same check runs here first.
      const problems = problemsWith(config, changes);
      const answer = problems.length === 0 ? await app.saveSettings?.(changes) : ({ status: 'invalid', problems } as const);
      // Out of reach: the panel's message has said so, and the form keeps what was typed.
      if (!answer) return false;
      if (answer.status === 'invalid') {
        if (import.meta.env.DEV) console.warn('The restaurant kept none of these settings:', answer.problems);
        setRefused(part);
        return false;
      }
      // Hours that leave bookings out send the focus to the notice that lists them, its top in sight, not to the button.
      close(part, answer.outsideHours.length > 0 ? 'outside-title' : opener);
      notify(answer.outsideHours.length > 0 ? typeset(t.panel.outside.saved(answer.outsideHours.length)) : s.saved);
      return true;
    };

  const sittings = (list: readonly Sitting[]) =>
    list.length === 0
      ? site.closed
      : list.map((sitting) => (
          <span class="fact__line fact__line--service" key={sitting.service}>
            {typeset(site.service(serviceName(config, sitting.service, language), sitting.firstSeating, sitting.lastSeating))}
          </span>
        ));
  const weekday = (day: number) => site.weekdays[day - 1] ?? '';
  const undocumented = config.menu.filter((entry) => ALLERGENS.some((allergen) => allergenStatus(entry, allergen) === 'unknown')).length;
  const seats = config.tables.reduce((sum, group) => sum + group.seats * group.count, 0);
  const tablesIn = (zone: string) => (config.floor?.tables ?? []).filter((table) => table.zone === zone).map((table) => table.number);
  const edit = (part: Part, title: string) =>
    canEdit && (
      <button type="button" class="tile__edit" id={`${part}-edit`} aria-describedby={title} onClick={() => open(part)}>
        {s.edit}
      </button>
    );

  return (
    <div class="screen screen--section">
      <SectionBar app={app} title={s.title} />
      {/* It scrolls on its own under the bar: focusable, so a keyboard scrolls it too. */}
      <div class="section__body" role="region" aria-labelledby="section-title" tabIndex={0}>
        <OutsideHours app={app} folded={false} onEdit={setMoving} />
        <div class="tiles">
          <div class={editing === 'hours' ? 'tiles__stack tile--wide' : 'tiles__stack'}>
            <section class={editing === 'hours' ? 'tile tile--wide' : 'tile'} aria-labelledby="hours-title">
              <div class="tile__head">
                <h2 class="tile__title" id="hours-title">
                  {s.hours}
                </h2>
                {edit('hours', 'hours-title')}
              </div>
              {editing === 'hours' ? (
                <div id="hours-form">
                  <HoursEditor app={app} refused={refused === 'hours'} save={save('hours')} onCancel={() => close('hours')} />
                </div>
              ) : (
                <dl class="facts">
                  {weekOf(config).map((row) => (
                    <div class="fact" key={row.first}>
                      <dt>{row.first === row.last ? weekday(row.first) : site.days(weekday(row.first), weekday(row.last))}</dt>
                      <dd>{sittings(row.sittings)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div class="tile__head">
                <h3 class="tile__subtitle" id="closures-title">
                  {s.exceptions}
                </h3>
                {edit('closures', 'closures-title')}
              </div>
              {editing === 'closures' ? (
                <div id="closures-form">
                  <ClosuresEditor app={app} refused={refused === 'closures'} save={save('closures')} onCancel={() => close('closures')} />
                </div>
              ) : config.exceptions.length === 0 ? (
                <p class="tile__help">{s.noExceptions}</p>
              ) : (
                <dl class="facts">
                  {config.exceptions.map((day) => (
                    <div class="fact" key={day.date}>
                      <dt>
                        {typeset(formatDate(day.date, language, snapshot.today))}
                        {day.reason && <span class="fact__help">{localize(day.reason, language)}</span>}
                      </dt>
                      <dd>{sittings(day.sittings)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>

            <section class="tile" aria-labelledby="languages-title">
              <h2 class="tile__title" id="languages-title">
                {s.languages}
              </h2>
              <ul class="plain">
                {config.languages.map((code) => (
                  <li key={code}>
                    {t.panel.languages[code]}
                    {code === config.defaultLanguage && <span class="plain__note"> ({s.defaultLanguage})</span>}
                  </li>
                ))}
              </ul>
              <p class="tile__help">{s.languagesHelp}</p>
            </section>
          </div>

          <section class="tile" aria-labelledby="rules-title">
            <div class="tile__head">
              <h2 class="tile__title" id="rules-title">
                {s.bookings}
              </h2>
              {edit('rules', 'rules-title')}
            </div>
            {editing === 'rules' ? (
              <div id="rules-form">
                <RulesEditor app={app} refused={refused === 'rules'} save={save('rules')} onCancel={() => close('rules')} />
              </div>
            ) : (
              <dl class="facts">
                <Fact name={s.notice} value={config.minNoticeMinutes === 0 ? s.noticeNone : s.noticeValue(config.minNoticeMinutes)} />
                <Fact name={s.advance} value={s.advanceValue(config.maxAdvanceDays)} />
                <Fact name={s.party} value={s.partyValue(config.maxPartySize)} />
              </dl>
            )}
            {/* What the plan and its tables rest on: read here, never changed with bookings sitting on them. */}
            <dl class="facts">
              <Fact name={s.slot} value={s.slotValue(config.slotMinutes)} />
              <div class="fact">
                <dt>{s.stays}</dt>
                <dd>
                  {config.stays.map((stay) => (
                    <span class="fact__line" key={stay.upToPartySize}>
                      {s.stayValue(stay.upToPartySize, stay.minutes)}
                    </span>
                  ))}
                </dd>
              </div>
              <Fact name={s.hold} value={s.holdValue(config.holdMinutes)} />
              <Fact name={s.emptySeats} value={s.emptySeatsValue(config.maxEmptySeats)} />
            </dl>
          </section>

          <section class="tile" aria-labelledby="floor-title">
            <h2 class="tile__title" id="floor-title">
              {s.floor}
            </h2>
            <p class="tile__lead">{s.seatsTotal(seats)}</p>
            <ul class="plain">
              {config.tables.map((group) => (
                <li key={group.id}>{s.tableGroup(group.count, group.seats)}</li>
              ))}
            </ul>
            {config.floor?.zones && (
              <ul class="plain">
                {config.floor.zones.map((zone) => (
                  <li key={zone.id}>{s.zoneTables(localize(zone.name, language), tablesIn(zone.id).join(', '))}</li>
                ))}
              </ul>
            )}
            {config.waiters && config.waiters.length > 0 && (
              <>
                <h3 class="tile__subtitle">{s.waiters}</h3>
                <ul class="plain">
                  {config.waiters.map((waiter) => {
                    const services = waiter.services?.map((service) => serviceName(config, service, language)).join(', ');
                    return <li key={waiter.id}>{s.waiterTables(services ? `${waiter.name}, ${services}` : waiter.name, waiter.tables.join(', '))}</li>;
                  })}
                </ul>
              </>
            )}
          </section>

          <section class="tile tile--wide" aria-labelledby="menu-title">
            <div class="tile__head">
              <h2 class="tile__title" id="menu-title">
                {s.menu}
              </h2>
              {canEdit && (
                <button type="button" class="tile__edit" id="menu-edit" onClick={() => setDish('new')}>
                  {s.addDish}
                </button>
              )}
            </div>
            <p class="tile__lead">{typeset(s.menuSummary(config.menu.length, undocumented))}</p>
            <p class="tile__help">{s.menuHelp}</p>
            <MenuSheet app={app} canEdit={canEdit} onEdit={setDish} />
          </section>

          <section class="tile tile--wide" aria-labelledby="faq-title">
            <div class="tile__head">
              <h2 class="tile__title" id="faq-title">
                {s.faq}
              </h2>
              {edit('faq', 'faq-title')}
            </div>
            {editing === 'faq' ? (
              <div id="faq-form">
                <AnswersEditor app={app} refused={refused === 'faq'} save={save('faq')} onCancel={() => close('faq')} />
              </div>
            ) : (
              <dl class="answers">
                {config.faq.map((entry) => (
                  <div key={entry.id}>
                    <dt>{localize(entry.question, language)}</dt>
                    <dd>{localize(entry.answer, language)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </div>
      </div>
      {moving && (
        <BookingSheet
          t={t}
          language={language}
          config={config}
          booking={moving}
          date={moving.date}
          today={snapshot.today}
          minute={snapshot.minute}
          act={app.act}
          onDone={(made) => {
            setMoving(null);
            notify(t.panel.booking.changed(made.guestName, typeset(made.readBack)));
            // Moved back into the hours, the booking leaves the notice with the button that opened the sheet.
            requestAnimationFrame(() => (document.getElementById('outside-title') ?? document.getElementById('section-title'))?.focus());
          }}
          onClose={() => setMoving(null)}
        />
      )}
      {dish !== null && (
        <DishEditor
          app={app}
          dish={dish === 'new' ? null : dish}
          refused={refused === 'menu'}
          save={save('menu', dish === 'new' ? 'menu-edit' : `dish-${dish.id}`)}
          onCancel={() => close('menu', dish === 'new' ? 'menu-edit' : `dish-${dish.id}`)}
        />
      )}
    </div>
  );
}

function Fact({ name, value }: { name: string; value: string }) {
  return (
    <div class="fact">
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}
