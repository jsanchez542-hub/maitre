import { useEffect, useState } from 'preact/hooks';

/**
 * The restaurant's time, as a page shows it. None on the server's render, so the hour of the build is never written
 * into the page; then the browser's own, set right by the Worker's clock whenever it answers, turning on the minute.
 */
export function useRestaurantClock(): { now: Date | null; sync: (clock: string) => void } {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const at = Date.now() + offset;
      setNow(new Date(at));
      timer = window.setTimeout(tick, 60_000 - (at % 60_000));
    };
    tick();
    return () => clearTimeout(timer);
  }, [offset]);

  return { now, sync: (clock) => setOffset(Date.parse(clock) - Date.now()) };
}
