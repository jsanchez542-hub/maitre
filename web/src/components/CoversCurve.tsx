import type { Messages } from '../i18n/messages';
import type { CurvePoint } from '../lib/service-view';

interface Props {
  points: CurvePoint[];
  /** Now, on the service day's clock. */
  minute: number;
  seats: number;
  t: Messages['service'];
}

const WIDTH = 350;
const BASE = 70;
const RISE = 62;

export function CoversCurve({ points, minute, seats, t }: Props) {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2 || seats === 0) return null;

  const x = (at: number) => ((at - first.minute) / (last.minute - first.minute)) * WIDTH;
  const y = (covers: number) => BASE - (covers / seats) * RISE;
  const plotted = points.map((point) => ({ ...point, px: x(point.minute), py: y(point.covers) }));
  const peak = plotted.reduce((best, point) => (point.covers > best.covers ? point : best));
  // The number of seats goes on the side away from the peak, so the two labels never meet.
  const seatsLabel = peak.px > WIDTH / 2 ? { x: 0, anchor: 'start' } : { x: WIDTH, anchor: 'end' };

  // Before the service the whole curve is still ahead; after it, all of it is past.
  const past = plotted.filter((point) => point.minute <= minute);
  const ahead = plotted.filter((point) => point.minute >= minute);
  const before = past[past.length - 1];
  const after = ahead[0];
  const here =
    before && after
      ? { px: x(minute), py: after.minute > before.minute ? before.py + ((minute - before.minute) / (after.minute - before.minute)) * (after.py - before.py) : before.py }
      : undefined;
  const toPoints = (selection: { px: number; py: number }[]) => selection.map((point) => `${point.px.toFixed(1)},${point.py.toFixed(1)}`).join(' ');

  return (
    <figure class="curve">
      <svg viewBox="0 0 350 86" role="img" aria-label={t.curveLabel(peak.covers, peak.time, seats)}>
        <line class="curve__limit" x1="0" y1={BASE - RISE} x2={WIDTH} y2={BASE - RISE} />
        <text class="curve__text" x={seatsLabel.x} y={BASE - RISE + 11} text-anchor={seatsLabel.anchor}>
          {t.seats(seats)}
        </text>
        <polyline class="curve__past" points={toPoints(here ? [...past, here] : past)} />
        <polyline class="curve__ahead" points={toPoints(here ? [here, ...ahead] : ahead)} />
        <circle class="curve__peak" cx={peak.px} cy={peak.py} r="3" />
        <text class="curve__text curve__text--strong" x={Math.min(peak.px + 6, WIDTH - 70)} y={peak.py - 5}>
          {`${peak.covers} · ${peak.time}`}
        </text>
        {here && (
          <>
            <line class="curve__now" x1={here.px} y1={BASE - RISE} x2={here.px} y2={BASE} />
            <circle class="curve__now-dot" cx={here.px} cy={here.py} r="4.5" />
          </>
        )}
        <line class="curve__axis" x1="0" y1={BASE} x2={WIDTH} y2={BASE} />
        <text class="curve__text" x="0" y="84">
          {first.time}
        </text>
        <text class="curve__text" x={WIDTH} y="84" text-anchor="end">
          {last.time}
        </text>
      </svg>
      <figcaption>{t.curve}</figcaption>
    </figure>
  );
}
