import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

/**
 * Lays a full-screen dialog on the part of the page the visitor sees. A phone shows less of the page than the page is
 * told: its keyboard covers the bottom, and some browsers leave the page shifted once the keyboard has closed, so a
 * dialog as tall as the screen can sit off what is seen, and its fields with it. Where the browser behaves, this
 * changes nothing. With the keyboard up the dialog keeps its height and shows its end, as a browser does by itself, so
 * the newest lines stay in sight above the fields. Zoomed in by hand, the page is the visitor's to move.
 */
export function useOnVisibleArea(dialog: RefObject<HTMLDialogElement>, open: boolean): void {
  useEffect(() => {
    const element = dialog.current;
    const seen = window.visualViewport;
    if (!open || !element || !seen) return;
    const lay = () => {
      const zoomed = Math.abs(seen.scale - 1) > 0.01;
      // A keyboard takes more than a quarter of the height; the bars of a browser, or of an app around it, take less.
      const typing = seen.height < window.innerHeight * 0.75;
      element.style.height = zoomed || typing ? '' : `${seen.height}px`;
      element.style.maxHeight = zoomed || typing ? '' : 'none';
      element.style.top = zoomed ? '' : `${seen.offsetTop + (typing ? seen.height - element.offsetHeight : 0)}px`;
    };
    lay();
    seen.addEventListener('resize', lay);
    seen.addEventListener('scroll', lay);
    return () => {
      seen.removeEventListener('resize', lay);
      seen.removeEventListener('scroll', lay);
      element.style.height = '';
      element.style.maxHeight = '';
      element.style.top = '';
    };
  }, [open]);
}
