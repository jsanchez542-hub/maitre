import { ALLERGENS, isAllergen, type Allergen, type DishCategory } from './allergens.js';
import { DAY_FORMS, parseDay, type DateSpec } from './dates.js';
import { HANDOFF_REASONS, type BookingEngine, type CallbackResult, type Session } from './engine.js';
import { localize, messages, type Errand } from './i18n/index.js';
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

const CATEGORIES: readonly DishCategory[] = ['starter', 'main', 'dessert', 'drink', 'side'];
const MAX_TEXT = 600;

/**
 * One short text for the day, in a small grammar the code reads, instead of a
 * field per kind of date: some models fill every optional field with a default,
 * and one sent `month: 1` for "the 24th" in a real evaluation run.
 */
const DAY_PROPERTY = {
  day: {
    type: 'string',
    maxLength: 40,
    description: `The day the guest means, written in one of these forms: ${DAY_FORMS}. Describe what the guest said; never work out a calendar date yourself, the tool does it. "Vendredi prochain" and "next Friday" usually mean the coming Friday: write "friday".`,
  },
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
        ...DAY_PROPERTY,
        time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: '24-hour time, HH:mm. "8 pm" is "20:00".' },
        partySize: { type: 'integer', minimum: 1, description: 'Number of guests, children included.' },
        changingReference: {
          type: 'string',
          description: 'Only when moving an existing booking: its reference, so its own table is not counted as taken. Leave it out otherwise.',
        },
      },
      required: ['day', 'time', 'partySize'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_table',
    description:
      'Books the table set aside by find_table, under the guest’s name. Never ask for a phone number: the conversation already has one, or this tool says how to get it. Read back `booking.readBack` and the reference once it is booked. Never tell the guest an allergy is noted unless it is in `booking.allergies`.',
    inputSchema: {
      type: 'object',
      properties: {
        holdId: { type: 'string', description: 'From the "available" answer of find_table.' },
        guestName: { type: 'string', description: 'The name to book under, as the guest gave it.' },
        // Required on purpose: optional, one model skipped it three times out of three
        // and still told the guest "je prends note de l'allergie".
        allergies: {
          ...ALLERGEN_LIST,
          description:
            'Required. Every allergy or intolerance mentioned in this conversation for anyone in the party, so the kitchen is warned. An empty list only when none was mentioned.',
        },
        notes: { type: 'string', description: 'Optional: high chair, wheelchair access, birthday. Never put allergies here.' },
      },
      required: ['holdId', 'guestName', 'allergies'],
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
      'What the kitchen’s allergen sheet says about one dish. Reply with the `sayExactly` sentences word for word: do not rephrase, soften, summarise or add to them, and never answer an allergen question without this tool. When the sheet does not cover an allergen, this tool has already passed the question to the team (`passedToTeam`): do not call hand_over for it.',
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
    inputSchema: { type: 'object', properties: { ...DAY_PROPERTY }, additionalProperties: false },
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
      'Passes the conversation to the team, who call the guest back. Use it for parties larger than the maximum, events, complaints and anything you cannot do. Allergy questions the sheet does not cover are passed on by check_dish itself. Tell the guest the team will get back to them.',
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

const ERRANDS: Readonly<Record<ToolName, Errand>> = {
  find_table: 'looking',
  my_bookings: 'looking',
  get_menu: 'looking',
  opening_hours: 'looking',
  business_info: 'looking',
  check_dish: 'allergens',
  dishes_without: 'allergens',
  book_table: 'booking',
  cancel_booking: 'booking',
  change_booking: 'booking',
  confirm_booking: 'booking',
  hand_over: 'other',
};

/** What a batch of tool calls is about, for the line the phone says while they run: the most specific errand wins. */
export function errandOf(names: readonly string[]): Errand {
  const errands = names.map((name) => ERRANDS[name as ToolName] ?? 'other');
  return (['allergens', 'booking', 'looking'] as const).find((errand) => errands.includes(errand)) ?? 'other';
}

const PHONE_INSTRUCTIONS: Record<Channel, string> = {
  web: 'Ask the guest to type their phone number in the field shown below the chat. Do not ask them to write it in the conversation.',
  voice: 'Ask the caller to type their phone number on the keypad, then press the hash key.',
  whatsapp: 'The number of this conversation is missing. Apologise and use hand_over.',
  staff: 'Enter the guest’s phone number in the booking form.',
};

/**
 * When the team has a request but no number to call back on, the channel asks
 * for one: `needsPhone` makes the web chat show its phone field.
 */
function phoneRequest(result: CallbackResult, channel: Channel): { needsPhone?: true; instruction?: string } {
  if (result.status !== 'recorded' || !result.needsPhone || (channel !== 'web' && channel !== 'voice')) return {};
  return { needsPhone: true, instruction: `The team needs a number to call the guest back. ${PHONE_INSTRUCTIONS[channel]}` };
}

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

  /**
   * A list of allergens. `presence: 'required'` asks for the field but accepts
   * an empty list; `presence: 'non_empty'` needs at least one.
   */
  allergens(input: Input, key: string, presence: 'optional' | 'required' | 'non_empty'): Allergen[] | undefined {
    const value = input[key];
    if (value === undefined || value === null) {
      if (presence !== 'optional') this.add(`${key} is required${presence === 'required' ? ' (an empty list when none was mentioned)' : ''}`);
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
    if (presence === 'non_empty' && allergens.length === 0) this.add(`${key} needs at least one allergen`);
    return allergens;
  }

  day(input: Input, required: boolean): DateSpec | undefined {
    const value = input['day'];
    if (value === undefined || value === null || value === '') {
      if (required) this.add('day is required');
      return undefined;
    }
    const spec = typeof value === 'string' ? parseDay(value) : undefined;
    if (!spec) this.add(`day "${String(value).slice(0, 40)}" is not one of the forms: ${DAY_FORMS}`);
    return spec;
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
      const date = check.day(input, true);
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
      const allergies = check.allergens(input, 'allergies', 'required');
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
      const allergens = check.allergens(input, 'allergens', 'non_empty');
      if (check.list.length > 0 || dishId === undefined || !allergens) return invalid(check.list);
      const result = checkDish(engine.config, language, dishId, allergens);
      if (result.status !== 'ok') return { status: 'unknown_dish', hint: 'Call get_menu for the dish ids.' };
      // The sheet's own sentence tells the guest the question goes to the team, so the code sends it
      // rather than trusting the model to: a model that says so and does not is a guest left waiting.
      const unknown = result.findings.filter((finding) => finding.answer === 'unknown').map((finding) => finding.allergen);
      const team = result.passToTeam
        ? engine.requestCallback(session, { reason: 'allergy_question', summary: messages(language).allergenQuestion(result.dish, unknown) })
        : undefined;
      return {
        status: 'ok',
        dish: result.dish,
        sayExactly: result.findings.map((finding) => finding.sentence),
        findings: result.findings.map(({ allergen, answer }) => ({ allergen, answer })),
        ...(team?.status === 'recorded' ? { passedToTeam: true, ...phoneRequest(team, session.channel) } : {}),
      };
    }
    case 'dishes_without': {
      const allergens = check.allergens(input, 'allergens', 'non_empty');
      if (check.list.length > 0 || !allergens) return invalid(check.list);
      return { status: 'ok', ...safeDishes(engine.config, language, allergens) };
    }
    case 'opening_hours': {
      const date = check.day(input, false);
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
      const result = engine.requestCallback(session, { reason, summary });
      return { ...result, ...phoneRequest(result, session.channel) };
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
