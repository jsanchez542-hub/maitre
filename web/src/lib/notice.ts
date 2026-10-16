import type { StaffActionResult, StaffBookResult, StaffChangeResult, TableActionResult } from 'maitre';
import type { Messages } from '../i18n/messages';
import { stageOf } from './service-view';

export type EngineAnswer = StaffActionResult | TableActionResult | StaffBookResult | StaffChangeResult;

/** The engine's answer in the page's words. Its `problems` are written for developers and never reach the screen. */
export function noticeFor(outcome: EngineAnswer, t: Messages['service']): string {
  switch (outcome.status) {
    case 'done':
    case 'booked':
      return t.done(outcome.booking.guestName, t.stage[stageOf(outcome.booking)]);
    case 'not_found':
      return t.notFound;
    case 'not_allowed':
      return t.refusal[outcome.reason];
    case 'table_taken':
      return t.tableTaken(outcome.free);
    case 'unknown_table':
      return t.unknownTable;
    case 'unavailable': {
      const times = outcome.alternatives.map((offer) => offer.readBack);
      return times.length > 0 ? `${t.unavailable[outcome.reason]} ${t.alternatives(times)}` : t.unavailable[outcome.reason];
    }
    case 'invalid':
      return t.invalid;
  }
}
