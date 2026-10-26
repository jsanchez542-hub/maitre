import { formatDate, localNow, type CallbackView, type Language, type PlainDate } from 'maitre';
import type { Messages } from '../i18n/messages';
import { telHref } from '../lib/service-view';
import { typeset } from '../lib/typography';

interface Props {
  t: Messages;
  language: Language;
  timeZone: string;
  today: PlainDate;
  callbacks: readonly CallbackView[];
  onDone: (id: string) => void;
  onClose: () => void;
}

/** «À rappeler»: what each guest asked, how they came and when, their number to call, and «Fait» once the team has. */
export function Callbacks({ t, language, timeZone, today, callbacks, onDone, onClose }: Props) {
  const c = t.panel.callbacks;
  const when = (callback: CallbackView) => {
    const moment = localNow(new Date(callback.createdAt), timeZone);
    const time = moment.date === today ? moment.time : `${formatDate(moment.date, language, today)}, ${moment.time}`;
    return typeset(c.when(time, callback.channel));
  };
  return (
    <div class="popover popover--list" id="callbacks" role="group" aria-label={c.title}>
      <p class="popover__label">{c.title}</p>
      {callbacks.length === 0 ? (
        <p class="callbacks__empty">{c.empty}</p>
      ) : (
        <ul class="callbacks">
          {callbacks.map((callback) => (
            <li class="callback" key={callback.id}>
              <p class="callback__when">{when(callback)}</p>
              <p class="callback__summary" id={`callback-${callback.id}`}>
                {typeset(callback.summary)}
              </p>
              {callback.phone && <p class="callback__phone">{callback.phone}</p>}
              <div class="callback__actions">
                {callback.phone && (
                  <a class="action" href={telHref(callback.phone)} aria-describedby={`callback-${callback.id}`}>
                    {c.call}
                  </a>
                )}
                <button type="button" class="action" aria-describedby={`callback-${callback.id}`} onClick={() => onDone(callback.id)}>
                  {c.done}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" class="action action--quiet" onClick={onClose}>
        {t.service.close}
      </button>
    </div>
  );
}
