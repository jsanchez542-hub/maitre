import type { Messages } from '../i18n/messages';

/** The room is 1.44 times as wide as it is deep; the drawing keeps that ratio so stools stay round. */
const W = 1.44;
const x = (percent: number) => percent * W;

const STOOLS = [32, 40, 48, 56, 64, 72];

/**
 * The demo restaurant around the tables the engine places: walls, the street
 * windows at the top, the banquette, the bar and its stools, the door and the
 * kitchen pass. Coordinates in percent of the room, as in the design brief.
 */
export function MerrainRoom({ t }: { t: Messages['service'] }) {
  const door = { from: x(60), to: x(72) };
  const leaf = door.to - door.from;
  return (
    <>
      <svg class="room" viewBox={`0 0 ${x(100)} 100`} aria-hidden="true" focusable="false">
        <rect class="room__floor" x={x(1)} y="1.5" width={x(98)} height="97" />
        <path class="room__wall" d={`M${x(18)} 1.5H${x(1)}V98.5H${door.from}M${door.to} 98.5H${x(99)}V1.5H${x(90)}M${x(38)} 1.5H${x(44)}M${x(64)} 1.5H${x(70)}`} />
        <path class="room__window" d={`M${x(18)} 1.5H${x(38)}M${x(44)} 1.5H${x(64)}M${x(70)} 1.5H${x(90)}`} />
        <rect class="room__bench" x={x(2)} y="22" width={x(4)} height="60" rx="1.6" />
        <path class="room__bar" d={`M${x(88)} 26H${x(93)}V85H${x(80)}V80H${x(88)}Z`} />
        {STOOLS.map((y) => (
          <circle key={y} class="room__stool" cx={x(85)} cy={y} r="1.5" />
        ))}
        <path class="room__door" d={`M${door.from} 98.5V${98.5 - leaf}`} />
        <path class="room__swing" d={`M${door.to} 98.5A${leaf} ${leaf} 0 0 0 ${door.from} ${98.5 - leaf}`} />
        <rect class="room__pass" x={x(20)} y="96.5" width={x(14)} height="2" />
      </svg>
      <span class="plan__label plan__label--kitchen">{t.kitchen}</span>
      <span class="plan__label plan__label--entrance">{t.entrance}</span>
    </>
  );
}
