import { ALLERGENS, isAllergen, type Allergen, type DishCategory } from './allergens.js';
import type { Weekday } from './calendar.js';
import type { DateSpec } from './dates.js';
import { HANDOFF_REASONS, type BookingEngine, type Session } from './engine.js';
import { localize } from './i18n/index.js';
import { checkDish, menuView, safeDishes } from './menu.js';
import type { Channel } from './store.js';

/**
 * The tools the language model can call, and the code that runs them.
 *
 * Definitions are provider-neutral: a name, a description that tells the model
 * when to use the tool and what it must never do, and a JSON Schema. Schemas
 * use flat fields only, which every provider's tool calling understands.
 */

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
}

export type ToolName =
  | 'find_table'
  | 'book_table'
  | 'my_bookings'
  | 'cancel_booking'
  | 'change_booking'
  | 'confirm_booking'
  | 'get_menu'
  | 'check_dish'
  | 'dishes_without'
  | 'opening_hours'
  | 'business_info'
  | 'hand_over';

export interface ToolOutput {
  status: string;
  [key: string]: unknown;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const CATEGORIES: readonly DishCategory[] = ['starter', 'main', 'dessert', 'drink', 'side'];
const MAX_TEXT = 600;

const DATE_PROPERTIES = {
  dateKind: {
    type: 'string',
    enum: ['date', 'relative', 'weekday', 'day_of_month'],
    description:
      'How the guest gave the day. Describe what they said; never work out a calendar date yourself, the tool does it.',
  },
  date: { type: 'string', description: 'YYYY-MM-DD. Only with dateKind "date", when the guest gave a full date.' },
  daysFromToday: {
    type: 'integer',
    minimum: 0,
    description: 'Only with dateKind "relative": 0 for today or tonight, 1 for tomorrow, 2 for the day after tomorrow.',
  },
  weekday: { type: 'string', enum: WEEKDAYS, description: 'Only with dateKind "weekday".' },
  week: {
    type: 'string',
    enum: ['this', 'next'],
    description:
      'Only with dateKind "weekday". "this": the nearest such day from today, today included. Use it also for "vendredi prochain" or "next Friday", which usually mean the coming one. "next": the same day in the following Monday-to-Sunday week, only when the guest clearly means the week after ("la semaine prochaine").',
  },
  dayOfMonth: { type: 'integer', minimum: 1, maximum: 31, description: 'Only with dateKind "day_of_month", for "le 11".' },
  month: { type: 'integer', minimum: 1, maximum: 12, description: 'Optional with dateKind "day_of_month", when the guest names the month.' },
} as const;

const ALLERGEN_LIST = { type: 'array', items: { type: 'string', enum: ALLERGENS }, uniqueItems: true } as const;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'find_table',
    description:
      'Checks whether a table is free and, if it is, sets it aside for this guest for a few minutes. Call it before saying anything about availability: never tell a guest a table is free unless this returned status "available". On "available", read `readBack` to the guest and ask for the name to book under. On "unavailable", say so and offer the `alternatives`, which are not set aside: call find_table again for the one the guest picks. On "needs_staff", use hand_over.',
    inputSchema: {
      type: 'object',
      properties: {
        ...DATE_PROPERTIES,
        time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: '24-hour time, HH:mm. "8 pm" is "20:00".' },
        partySize: { type: 'integer', minimum: 1, description: 'Number of guests, children included.' },
        changingReference: {
          type: 'string',
          description: 'When moving an existing booking: its reference, so its own table is not counted as taken.',
        },
      },
      required: ['dateKind', 'time', 'partySize'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_table',
    description:
      'Books the table set aside by find_table, under the guest’s name. Never ask for a phone number: the conversation already has one, or this tool says how to get it. If the guest mentioned an allergy or intolerance, pass it in `allergies` so the kitchen is warned. Read back `booking.readBack` and the reference once it is booked.',
    inputSchema: {
      type: 'object',
      properties: {
        holdId: { type: 'string', description: 'From the "available" answer of find_table.' },
        guestName: { type: 'string', description: 'The name to book under, as the guest gave it.' },
        notes: { type: 'string', description: 'Optional: high chair, wheelchair access, birthday. Never put allergies here.' },
        allergies: { ...ALLERGEN_LIST, description: 'Allergies the guest declared for this booking.' },
      },
      required: ['holdId', 'guestName'],
      additionalProperties: false,
    },
  },
  {
    name: 'my_bookings',
    description:
      'Lists the guest’s upcoming bookings, found from the phone number of this conversation. Use it before cancelling or changing when the guest has no reference.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_booking',
    description: 'Cancels one of the guest’s bookings. Repeat the booking to the guest and get a clear yes before calling.',
    inputSchema: {
      type: 'object',
      properties: { reference: { type: 'string', description: 'Six characters, from my_bookings or the confirmation.' } },
      required: ['reference'],
      additionalProperties: false,
    },
  },
  {
    name: 'change_booking',
    description:
      'Moves a booking to another time, day or party size. First call find_table with `changingReference`, then call this with the reference and the new holdId. The old table is freed in the same step.',
    inputSchema: {
      type: 'object',
      properties: { reference: { type: 'string' }, holdId: { type: 'string' } },
      required: ['reference', 'holdId'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirm_booking',
    description: 'Marks the guest’s next booking as confirmed when they say they are coming, for example in reply to a reminder.',
    inputSchema: {
      type: 'object',
      properties: { reference: { type: 'string', description: 'Optional: a specific booking.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_menu',
    description: 'The dishes on the menu with their ids and prices. Use the ids with check_dish.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', enum: CATEGORIES } },
      additionalProperties: false,
    },
  },
  {
    name: 'check_dish',
    description:
      'What the kitchen’s allergen sheet says about one dish. Reply with the `sayExactly` sentences word for word: do not rephrase, soften, summarise or add to them, and never answer an allergen question without this tool. If `passToTeam` is true, also call hand_over with reason "allergy_question".',
    inputSchema: {
      type: 'object',
      properties: {
        dishId: { type: 'string', description: 'From get_menu.' },
        allergens: { ...ALLERGEN_LIST, minItems: 1 },
      },
      required: ['dishId', 'allergens'],
      additionalProperties: false,
    },
  },
  {
    name: 'dishes_without',
    description:
      'Dishes that contain none of these allergens according to the kitchen’s sheet. Dishes in `undocumented` are not covered by the sheet: say so, and never present them as safe.',
    inputSchema: {
      type: 'object',
      properties: { allergens: { ...ALLERGEN_LIST, minItems: 1 } },
      required: ['allergens'],
      additionalProperties: false,
    },
  },
  {
    name: 'opening_hours',
    description:
      'The times a table can be booked: for one day if date fields are given, otherwise for the next seven days. Exceptional closures are included.',
    inputSchema: { type: 'object', properties: { ...DATE_PROPERTIES }, additionalProperties: false },
  },
  {
    name: 'business_info',
    description:
      'The answers the restaurant has written to common questions (parking, payment, accessibility and so on). Use only these answers. If the question is not covered, say you do not know and offer hand_over.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hand_over',
    description:
      'Passes the conversation to the team, who call the guest back. Use it for parties larger than the maximum, events, complaints, allergy questions the sheet does not answer, and anything you cannot do. Tell the guest the team will get back to them.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: HANDOFF_REASONS },
        summary: { type: 'string', description: 'What the guest wants, in one or two sentences, for the team.' },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
  },
];

const PHONE_INSTRUCTIONS: Record<Channel, string> = {
  web: 'Ask the guest to type their phone number in the field shown below the chat. Do not ask them to write it in the conversation.',
  voice: 'Ask the caller to type their phone number on the keypad, then press the hash key.',
  whatsapp: 'The number of this conversation is missing. Apologise and use hand_over.',
  staff: 'Enter the guest’s phone number in the booking form.',
};

type Input = Record<string, unknown>;

class InputProblems {
  readonly list: string[] = [];

  add(problem: string): void {
    this.list.push(problem);
  }

  text(input: Input, key: string, required: boolean): string | undefined {
    const value = input[key];
    if (value === undefined || value === null) {
      if (required) this.add(`${key} is required`);
      return undefined;
    }
    if (typeof value !== 'string' || value.length > MAX_TEXT) {
      this.add(`${key} must be text of at most ${MAX_TEXT} characters`);
      return undefined;
    }
    return value;
  }

  integer(input: Input, key: string, required: boolean): number | undefined {
    const value = input[key];
    if (value === undefined || value === null) {
      if (required) this.add(`${key} is required`);
      return undefined;
    }
    if (!Number.isInteger(value)) {
      this.add(`${key} must be a whole number`);
      return undefined;
    }
    return value as number;
  }

  allergens(input: Input, key: string, required: boolean): Allergen[] | undefined {
    const value = input[key];
    if (value === undefined || value === null) {
      if (required) this.add(`${key} is required`);
      return undefined;
    }
    if (!Array.isArray(value) || value.length > ALLERGENS.length) {
      this.add(`${key} must be a list of allergens`);
      return undefined;
    }
    const allergens: Allergen[] = [];
    for (const item of value) {
      if (!isAllergen(item)) this.add(`unknown allergen "${String(item).slice(0, 40)}"; use one of ${ALLERGENS.join(', ')}`);
      else if (!allergens.includes(item)) allergens.push(item);
    }
    if (required && allergens.length === 0) this.add(`${key} needs at least one allergen`);
    return allergens;
  }

  date(input: Input, required: boolean): DateSpec | undefined {
    const kind = input['dateKind'];
    if (kind === undefined || kind === null) {
      if (required) this.add('dateKind is required');
      return undefined;
    }
    switch (kind) {
      case 'date': {
        const date = this.text(input, 'date', true);
        return date === undefined ? undefined : { kind: 'date', date };
      }
      case 'relative': {
        const days = this.integer(input, 'daysFromToday', true);
        return days === undefined ? undefined : { kind: 'relative', days };
      }
      case 'weekday': {
        const weekday = WEEKDAYS.indexOf(input['weekday'] as (typeof WEEKDAYS)[number]);
        const week = input['week'];
        if (weekday < 0) this.add(`weekday must be one of ${WEEKDAYS.join(', ')}`);
        if (week !== 'this' && week !== 'next') this.add('week must be "this" or "next"');
        if (weekday < 0 || (week !== 'this' && week !== 'next')) return undefined;
        return { kind: 'weekday', weekday: (weekday + 1) as Weekday, week };
      }
      case 'day_of_month': {
        const day = this.integer(input, 'dayOfMonth', true);
        const month = this.integer(input, 'month', false);
        if (day === undefined) return undefined;
        return month === undefined ? { kind: 'day_of_month', day } : { kind: 'day_of_month', day, month };
      }
      default:
        this.add('dateKind must be one of date, relative, weekday, day_of_month');
        return undefined;
    }
  }
}

function invalid(problems: string[]): ToolOutput {
  return { status: 'invalid_input', problems };
}

function run(engine: BookingEngine, session: Session, name: string, input: Input): ToolOutput {
  const check = new InputProblems();
  const language = session.language;

  switch (name) {
    case 'find_table': {
      const date = check.date(input, true);
      const time = check.text(input, 'time', true);
      const partySize = check.integer(input, 'partySize', true);
      const changing = check.text(input, 'changingReference', false);
      if (check.list.length > 0 || !date || time === undefined || partySize === undefined) return invalid(check.list);
      return engine.findTable(session, { date, time, partySize, ...(changing === undefined ? {} : { changing }) });
    }
    case 'book_table': {
      const holdId = check.text(input, 'holdId', true);
      const guestName = check.text(input, 'guestName', true);
      const notes = check.text(input, 'notes', false);
      const allergies = check.allergens(input, 'allergies', false);
      if (check.list.length > 0 || holdId === undefined || guestName === undefined) return invalid(check.list);
      const result = engine.book(session, {
        holdId,
        guestName,
        ...(notes === undefined ? {} : { notes }),
        ...(allergies === undefined ? {} : { allergies }),
      });
      return result.status === 'phone_required' ? { ...result, instruction: PHONE_INSTRUCTIONS[session.channel] } : result;
    }
    case 'my_bookings': {
      const result = engine.myBookings(session);
      return result.status === 'phone_required' ? { ...result, instruction: PHONE_INSTRUCTIONS[session.channel] } : result;
    }
    case 'cancel_booking': {
      const reference = check.text(input, 'reference', true);
      if (reference === undefined) return invalid(check.list);
      return engine.cancel(session, { reference });
    }
    case 'change_booking': {
      const reference = check.text(input, 'reference', true);
      const holdId = check.text(input, 'holdId', true);
      if (reference === undefined || holdId === undefined) return invalid(check.list);
      return engine.change(session, { reference, holdId });
    }
    case 'confirm_booking': {
      const reference = check.text(input, 'reference', false);
      if (check.list.length > 0) return invalid(check.list);
      return engine.confirm(session, reference === undefined ? {} : { reference });
    }
    case 'get_menu': {
      const category = input['category'];
      if (category !== undefined && !CATEGORIES.includes(category as DishCategory)) {
        return invalid([`category must be one of ${CATEGORIES.join(', ')}`]);
      }
      return { status: 'ok', dishes: menuView(engine.config, language, category as DishCategory | undefined) };
    }
    case 'check_dish': {
      const dishId = check.text(input, 'dishId', true);
      const allergens = check.allergens(input, 'allergens', true);
      if (check.list.length > 0 || dishId === undefined || !allergens) return invalid(check.list);
      const result = checkDish(engine.config, language, dishId, allergens);
      if (result.status !== 'ok') return { status: 'unknown_dish', hint: 'Call get_menu for the dish ids.' };
      return {
        status: 'ok',
        dish: result.dish,
        sayExactly: result.findings.map((finding) => finding.sentence),
        findings: result.findings.map(({ allergen, answer }) => ({ allergen, answer })),
        passToTeam: result.passToTeam,
      };
    }
    case 'dishes_without': {
      const allergens = check.allergens(input, 'allergens', true);
      if (check.list.length > 0 || !allergens) return invalid(check.list);
      return { status: 'ok', ...safeDishes(engine.config, language, allergens) };
    }
    case 'opening_hours': {
      const date = check.date(input, false);
      if (check.list.length > 0) return invalid(check.list);
      return engine.openingHours(language, date);
    }
    case 'business_info':
      return {
        status: 'ok',
        answers: engine.config.faq.map((entry) => ({
          question: localize(entry.question, language),
          answer: localize(entry.answer, language),
        })),
      };
    case 'hand_over': {
      const reason = check.text(input, 'reason', true);
      const summary = check.text(input, 'summary', true);
      if (reason === undefined || summary === undefined) return invalid(check.list);
      return engine.requestCallback(session, { reason, summary });
    }
    default:
      return { status: 'unknown_tool', tools: TOOL_DEFINITIONS.map((tool) => tool.name) };
  }
}

/**
 * Runs one tool call from the model. Never throws: a bug in the engine becomes
 * an "internal_error" the model can apologise for, and `onError` hears about it.
 */
export function runTool(
  engine: BookingEngine,
  session: Session,
  name: string,
  input: unknown,
  onError?: (error: unknown) => void,
): ToolOutput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid(['the input must be an object']);
  }
  try {
    return run(engine, session, name, input as Input);
  } catch (error) {
    onError?.(error);
    return { status: 'internal_error' };
  }
}
