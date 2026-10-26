import type { Messages } from '../i18n/messages';
import type { CurvePoint } from '../lib/service-view';

interface Props {
  points: CurvePoint[];
  /** Now, on the service day's clock. */
  minute: number;
  seats: number;
  t: Messages['service'];
}

export function CoversChart({ points, minute, seats, t }: Props) {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2 || seats === 0) return null;

  const share = (covers: number) => Math.min(100, (covers / seats) * 100);
  const column = (index: number) => ((index + 0.5) / points.length) * 100;
  const step = (last.minute - first.minute) / (points.length - 1);
  const peak = points.reduce((best, point) => (point.covers > best.covers ? point : best));
  const peakAt = column(points.indexOf(peak));
  const now = minute >= first.minute && minute <= last.minute ? column((minute - first.minute) / step) : undefined;
  // The number of seats goes on the side away from the peak, so the two labels never meet,
  // and the peak's own label runs away from the line that marks now.
  const seatsAtStart = peakAt > 50;
  const peakTowardsEnd = now === undefined || now <= peakAt;

  return (
    <figure class="chart">
      <div class="chart__plot" role="img" aria-label={t.curveLabel(peak.covers, peak.time, seats)}>
        <span class={seatsAtStart ? 'chart__limit chart__limit--start' : 'chart__limit'}>{t.seats(seats)}</span>
        {points.map((point) => (
          <span key={point.minute} class={point.minute <= minute ? 'chart__bar is-past' : 'chart__bar'} style={{ height: `${share(point.covers)}%` }} />
        ))}
        {peak.covers > 0 && (
          <span class={peakTowardsEnd ? 'chart__peak' : 'chart__peak chart__peak--before'} style={{ left: `${peakAt}%`, bottom: `${share(peak.covers)}%` }}>
            {t.peak(peak.covers, peak.time)}
          </span>
        )}
        {now !== undefined && <span class="chart__now" style={{ left: `${now}%` }} />}
      </div>
      <div class="chart__axis" aria-hidden="true">
        <span>{first.time}</span>
        <span>{last.time}</span>
      </div>
      <figcaption>{t.curve}</figcaption>
    </figure>
  );
}
