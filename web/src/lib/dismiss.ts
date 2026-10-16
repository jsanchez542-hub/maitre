import type { RefObject } from 'preact';
import { useLayoutEffect } from 'preact/hooks';

/**
 * A popover over the room closes as a menu does: on Escape, which gives the focus back to the button that opened it,
 * and on a press anywhere outside the popover and that button, which leaves the focus where the press put it. Open,
 * it would otherwise sit over the table card the next press opens.
 */
export function useDismiss(open: boolean, popover: string, opener: RefObject<HTMLElement>, close: () => void): void {
  // Listening from the render that opens it: an Escape pressed straight after must not find it deaf.
  useLayoutEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (document.getElementById(popover)?.contains(target) === true || opener.current?.contains(target) === true);
    const press = (event: PointerEvent) => {
      // On the phone a list may open in the page itself: the page scrolls under the finger, and the list stays open.
      const element = document.getElementById(popover);
      if (!element || getComputedStyle(element).position === 'static') return;
      if (!inside(event.target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      opener.current?.focus();
    };
    document.addEventListener('pointerdown', press);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', press);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
}
