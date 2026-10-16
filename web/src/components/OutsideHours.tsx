import { formatDate, type StaffBookingView } from 'maitre';
import { useRef, useState } from 'preact/hooks';
import { useDismiss } from '../lib/dismiss';
import { noticeFor } from '../lib/notice';
import { telHref } from '../lib/service-view';
import { typeset } from '../lib/typography';
import type { PanelApp } from './Panel';
import { Undo } from './TableCard';

/**
 * The bookings the opening hours now leave out: guests who would find the door closed, once a day is closed or a
 * service shortened. Listed until the staff move or cancel each, with the number to call first. Folded to one line on
 * the service, where the list opens over the room instead of pushing it off the screen; open in the settings, where
 * the hours changed.
 */
export function OutsideHours({ app, folded, onEdit }: { app: PanelApp; folded: boolean; onEdit: (booking: StaffBookingView) => void }) {
  const { t, language, snapshot, outside, act, notify } = app;
  const o = t.panel.outside;
  const [open, setOpen] = useState(!folded);
  const toggle = useRef<HTMLButtonElement>(null);
  useDismiss(folded && open, 'outside-list', toggle, () => setOpen(false));
  if (outside.length === 0) return null;
  const cancel = async (reference: string) => {
    const answer = await act((backend) => backend.cancel(reference, language));
    if (!answer) return;
    notify(noticeFor(answer, t.service));
    // The booking leaves the list with the button that cancelled it: the focus goes to the notice, or to the section once it is gone.
    if (answer.status === 'done') requestAnimationFrame(() => (document.getElementById('outside-title') ?? document.getElementById('section-title'))?.focus());
  };
  // Over the room the list is a menu: it closes as the sheet opens, and the sheet gives the focus back to its button.
  const edit = (booking: StaffBookingView) => {
    if (folded) {
      setOpen(false);
      toggle.current?.focus();
    }
    onEdit(booking);
  };

  return (
    <section class={folded ? 'outside outside--folded' : 'outside'} aria-labelledby="outside-title">
      <div class="outside__head">
        <h2 class="outside__title" id="outside-title" tabIndex={-1}>
          {typeset(o.title(outside.length))}
        </h2>
        {folded && (
          <button type="button" class="action action--small" ref={toggle} aria-expanded={open} aria-controls="outside-list" onClick={() => setOpen(!open)}>
            {open ? o.hide : o.show}
          </button>
        )}
      </div>
      {open && (
        <div id="outside-list" class={folded ? 'outside__body popover popover--list' : 'outside__body'}>
          <p class="outside__help">{o.help(outside.length)}</p>
          <ul class="outside__list">
            {outside.map((booking) => {
              const who = `outside-${booking.reference}`;
              return (
                <li class="outside__item" key={booking.reference}>
                  <p class="outside__who" id={who}>
                    {booking.guestName} · {t.service.covers(booking.partySize)}
                  </p>
                  <p class="outside__when">{`${typeset(formatDate(booking.date, language, snapshot.today))}, ${booking.time}`}</p>
                  {booking.phone && <p class="outside__phone">{booking.phone}</p>}
                  <div class="outside__actions">
                    {booking.phone && (
                      <a class="action" href={telHref(booking.phone)} aria-describedby={who}>
                        {t.panel.callbacks.call}
                      </a>
                    )}
                    <button type="button" class="action" aria-haspopup="dialog" aria-describedby={who} onClick={() => edit(booking)}>
                      {t.service.edit}
                    </button>
                    <Undo party={booking} t={t.service} onCancel={(reference) => void cancel(reference)} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
