import { describe, expect, it } from 'vitest';
import { chairsFor } from './chairs';

describe('the chairs around a table', () => {
  it('seats a table for two face to face', () => {
    const chairs = chairsFor({ shape: 'round', seats: 2 });
    expect(chairs.map((chair) => [chair.x, chair.y].map((value) => Math.round(value * 100) / 100))).toEqual([
      [0.5, 0],
      [0.5, 1],
    ]);
  });

  it('puts one chair on each side of a square table for four', () => {
    expect(chairsFor({ shape: 'square', seats: 4 }).map((chair) => chair.turn)).toEqual([0, 180, 270, 90]);
  });

  it('lines a long table for six with three chairs on each long side', () => {
    const turns = chairsFor({ shape: 'rect', seats: 6 }).map((chair) => chair.turn);
    expect(turns.filter((turn) => turn === 0)).toHaveLength(3);
    expect(turns.filter((turn) => turn === 180)).toHaveLength(3);
  });

  it('turns the long sides when the table is turned', () => {
    const turns = chairsFor({ shape: 'rect', seats: 6, rotation: 90 }).map((chair) => chair.turn);
    expect(new Set(turns)).toEqual(new Set([270, 90]));
  });

  it('puts a single chair on the room side of a table for two at the banquette', () => {
    expect(chairsFor({ shape: 'round', seats: 2, zone: 'banquette', x: 11 })).toEqual([{ x: 1, y: 0.5, turn: 90 }]);
    expect(chairsFor({ shape: 'round', seats: 2, zone: 'banquette', x: 89 })).toEqual([{ x: 0, y: 0.5, turn: 270 }]);
  });

  it('gives every table away from a banquette exactly one chair per seat, on its edge', () => {
    for (const shape of ['round', 'square', 'rect'] as const) {
      for (let seats = 1; seats <= 8; seats += 1) {
        const chairs = chairsFor({ shape, seats });
        expect(chairs).toHaveLength(seats);
        for (const chair of chairs) {
          expect(chair.x).toBeGreaterThanOrEqual(-1e-9);
          expect(chair.x).toBeLessThanOrEqual(1 + 1e-9);
          expect(chair.y).toBeGreaterThanOrEqual(-1e-9);
          expect(chair.y).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });
});
