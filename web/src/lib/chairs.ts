import type { FloorTableView } from 'maitre';

/**
 * One chair around a table: its centre on the table's edge, from 0 to 1 across
 * and down the table, and how far it is turned so that it faces the table.
 */
export interface Chair {
  x: number;
  y: number;
  turn: number;
}

type Side = 'top' | 'right' | 'bottom' | 'left';

const TURN: Record<Side, number> = { top: 0, right: 90, bottom: 180, left: 270 };

function along(side: Side, count: number): Chair[] {
  return Array.from({ length: count }, (_, index) => {
    const at = (index + 1) / (count + 1);
    const x = side === 'left' ? 0 : side === 'right' ? 1 : at;
    const y = side === 'top' ? 0 : side === 'bottom' ? 1 : at;
    return { x, y, turn: TURN[side] };
  });
}

/**
 * One chair per seat, placed the way a floor plan draws them: evenly around a
 * round table, along the long sides of a long table, a side each at a square
 * one. At a banquette the wall side sits on the bench, so only the room side
 * gets chairs.
 */
export function chairsFor(table: Pick<FloorTableView, 'shape' | 'seats' | 'rotation' | 'zone' | 'x'>): Chair[] {
  const { seats } = table;
  if (table.zone === 'banquette') return along((table.x ?? 0) < 50 ? 'right' : 'left', Math.ceil(seats / 2));
  if (table.shape === 'round') {
    return Array.from({ length: seats }, (_, index) => {
      const angle = -90 + (index * 360) / seats;
      const radians = (angle * Math.PI) / 180;
      return { x: 0.5 + Math.cos(radians) / 2, y: 0.5 + Math.sin(radians) / 2, turn: angle + 90 };
    });
  }
  if (table.shape === 'rect') {
    const [first, second, end]: [Side, Side, Side] = table.rotation === 90 ? ['left', 'right', 'bottom'] : ['top', 'bottom', 'right'];
    const half = Math.floor(seats / 2);
    return [...along(first, seats - half - (seats % 2)), ...along(second, half), ...along(end, seats % 2)];
  }
  const sides: Side[] = ['top', 'bottom', 'left', 'right'];
  const counts = sides.map((_, index) => Math.floor(seats / 4) + (index < seats % 4 ? 1 : 0));
  return sides.flatMap((side, index) => along(side, counts[index] ?? 0));
}
