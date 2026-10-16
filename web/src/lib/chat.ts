/** What the chat shows: the assistant's and the guest's words, a booking confirmed, a number sent from the field. */
export type Said = { from: 'agent' | 'guest'; text: string } | { from: 'booking'; readBack: string; reference: string } | { from: 'phone'; number: string };
export type Line = Said & { id: number };
