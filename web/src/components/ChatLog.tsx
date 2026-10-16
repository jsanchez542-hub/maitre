import type { ComponentChildren, RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import type { Messages } from '../i18n/messages';
import { BARREL } from '../lib/barrel';
import type { Line } from '../lib/chat';
import { typeset } from '../lib/typography';

/**
 * The newest line stays in view, as in any chat, also when the actions below take room from the log. `fromTop`
 * keeps the start in view instead, while what follows the conversation is a list to read from its first item.
 */
export function useNewestInView(log: RefObject<HTMLDivElement>, changes: readonly unknown[], fromTop = false): void {
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = fromTop ? 0 : element.scrollHeight;
  }, changes);
}

interface Props {
  lines: readonly Line[];
  typing: boolean;
  /** The real assistant answers: its thinking is said in words. A recording only shows the mark. */
  live?: boolean;
  t: Messages['chat'];
  log: RefObject<HTMLDivElement>;
  /** What follows the conversation in the same scroll, such as the recordings to choose from. */
  children?: ComponentChildren;
}

/** Merrain's barrel at the size of the text, its staves lighting in turn while the assistant thinks. */
function ThinkingMark() {
  return (
    <svg class="chat__thinking" viewBox={BARREL.viewBox} aria-hidden="true" focusable="false">
      <path d={BARREL.hoops} />
      {BARREL.staves.map((stave) => (
        <path key={stave} class="chat__stave" d={stave} />
      ))}
    </svg>
  );
}

/** The one scrolling part of the chat: the conversation, and whatever follows it. */
export function ChatLog({ lines, typing, live = false, t, log, children }: Props) {
  return (
    <div class="chat__log" role="log" aria-label={t.log} tabIndex={0} ref={log}>
      <ol class="chat__lines">
        {lines.map((line) =>
          line.from === 'phone' ? (
            <li key={line.id} class="chat__line chat__line--guest chat__line--phone">
              <span class="sr-only">{`${t.you} `}</span>
              {`${t.phoneSent} `}
              <span class="chat__number">{line.number}</span>
            </li>
          ) : line.from === 'booking' ? (
            <li key={line.id} class="chat__booking">
              <p class="chat__label">{t.booked}</p>
              <p class="chat__read-back">{typeset(line.readBack)}</p>
              <p class="chat__reference">{t.reference(line.reference)}</p>
            </li>
          ) : (
            <li key={line.id} class={`chat__line chat__line--${line.from}`}>
              {line.from === 'guest' && <span class="sr-only">{`${t.you} `}</span>}
              {typeset(line.text)}
            </li>
          ),
        )}
        {typing && (
          <li class="chat__typing">
            <ThinkingMark />
            <span class={live ? 'chat__typing-text' : 'sr-only'}>{typeset(t.typing)}</span>
          </li>
        )}
      </ol>
      {children}
    </div>
  );
}
