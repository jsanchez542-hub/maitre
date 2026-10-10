import type { Channel, Language, StaffRefusal, UnavailableReason } from 'maitre';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';

/** What a booking or a table is shown as, one word or two, in the list and on the plan. */
export type StageLabel = 'booked' | 'confirmed' | 'arrived' | 'seated' | 'left' | 'cancelled' | 'no_show' | 'held' | 'free';

export interface Messages {
  page: {
    title: string;
    description: string;
    heading: string;
    skip: string;
    languages: string;
    lead: (restaurant: string, day: string) => string;
  };
  notFound: {
    title: string;
    heading: string;
    body: string;
    back: string;
  };
  service: {
    region: string;
    now: (time: string) => string;
    later: string;
    laterLabel: string;
    sittings: string;
    covers: (count: number) => string;
    bookings: (count: number) => string;
    counters: string;
    allergies: (count: number) => string;
    callbacks: (count: number) => string;
    holds: (count: number) => string;
    views: string;
    plan: string;
    list: string;
    windows: string;
    entrance: string;
    curve: string;
    curveLabel: (peak: number, peakAt: string, seats: number) => string;
    stage: Record<StageLabel, string>;
    late: (minutes: number) => string;
    freeAt: (time: string) => string;
    movedFrom: (time: string) => string;
    walkIn: string;
    channel: Record<Channel, string>;
    table: (number: string) => string;
    seats: (count: number) => string;
    allergy: string;
    waiter: (name: string) => string;
    note: string;
    nextBooking: (name: string, time: string) => string;
    holdDetail: (partySize: number, time: string, until: string) => string;
    close: string;
    markArrived: string;
    seatAt: (table: string) => string;
    freeTable: string;
    walkInAsk: string;
    walkInSize: (count: number) => string;
    done: (name: string, stage: string) => string;
    refusal: Record<StaffRefusal, string>;
    notFound: string;
    tableTaken: (free: readonly string[]) => string;
    unknownTable: string;
    unavailable: Record<UnavailableReason, string>;
    alternatives: (times: readonly string[]) => string;
    invalid: string;
    empty: string;
  };
}

const MESSAGES: Record<Language, Messages> = { fr, en, es };

export function messagesFor(language: Language): Messages {
  return MESSAGES[language];
}
