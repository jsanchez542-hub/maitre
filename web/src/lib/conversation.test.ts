import { RECORDINGS, Replay, type ReplayedTurn } from 'maitre/demo';
import { describe, expect, it } from 'vitest';
import { bookedIn, outcomeOf } from './conversation';

function played(id: string): ReplayedTurn[] {
  const recording = RECORDINGS.find((candidate) => candidate.id === id);
  if (!recording) throw new Error(`No recording ${id}`);
  const replay = new Replay(recording);
  const turns: ReplayedTurn[] = [];
  for (let turn = replay.next(); turn; turn = replay.next()) turns.push(turn);
  return turns;
}

describe('what a conversation came to', () => {
  it('reads it from the engine’s answers', () => {
    expect(outcomeOf(played('book-fr'))).toBe('booked');
    expect(outcomeOf(played('large-group-fr'))).toBe('handover');
    expect(outcomeOf(played('cancel-fr'))).toBe('cancelled');
    expect(outcomeOf(played('change-en'))).toBe('changed');
    expect(outcomeOf(played('faq-en'))).toBe('answered');
  });

  it('counts an allergen question the sheet leaves open as passed to the team', () => {
    expect(outcomeOf(played('web-allergen-unknown-en'))).toBe('handover');
    expect(outcomeOf(played('web-allergen-known-fr'))).toBe('answered');
  });

  it('plays every recording to its end on the real engine', () => {
    for (const recording of RECORDINGS) expect(played(recording.id), recording.id).toHaveLength(recording.turns.length);
  });

  it('takes the confirmed booking from the engine’s answer, in the turn that made it', () => {
    const [asking, booking] = played('book-fr');
    expect(asking && bookedIn(asking)).toBeUndefined();
    expect(booking && bookedIn(booking)).toMatchObject({ date: '2026-10-16', time: '20:00', partySize: 4 });
    expect(booking && bookedIn(booking)?.reference).toMatch(/^[A-Z0-9]{6}$/);
  });
});
