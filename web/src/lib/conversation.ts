import type { ReplayedTurn } from 'maitre/demo';

/** What a conversation came to. */
export type Outcome = 'booked' | 'changed' | 'cancelled' | 'handover' | 'answered';

/** Read from what the engine answered, never from what the model said. */
export function outcomeOf(turns: readonly ReplayedTurn[]): Outcome {
  const tools = turns.flatMap((turn) => turn.tools);
  const answers = tools.map((tool) => `${tool.name}:${tool.output.status}`);
  if (answers.includes('book_table:booked')) return 'booked';
  if (answers.includes('change_booking:changed')) return 'changed';
  if (answers.includes('cancel_booking:cancelled')) return 'cancelled';
  if (answers.some((answer) => answer.startsWith('hand_over:') || answer === 'find_table:needs_staff')) return 'handover';
  // An allergen the sheet leaves open goes to the team from check_dish itself, with no hand_over.
  if (tools.some((tool) => tool.output['passedToTeam'] === true)) return 'handover';
  return 'answered';
}

export interface ChatBooked {
  reference: string;
  date: string;
  time: string;
  partySize: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The booking a turn made, as the engine confirmed it, or nothing. */
export function bookedIn(turn: ReplayedTurn): ChatBooked | undefined {
  for (const tool of turn.tools) {
    if (tool.name !== 'book_table' || tool.output.status !== 'booked') continue;
    const booking = tool.output['booking'];
    if (isRecord(booking) && typeof booking['reference'] === 'string' && typeof booking['date'] === 'string' && typeof booking['time'] === 'string' && typeof booking['partySize'] === 'number') {
      return { reference: booking['reference'], date: booking['date'], time: booking['time'], partySize: booking['partySize'] };
    }
  }
  return undefined;
}
