import type { Channel, DishCategory, Language, StaffRefusal, UnavailableReason } from 'maitre';
import type { ConversationResult } from '../lib/conversations';
import type { GroupId } from '../lib/service-view';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';

/** What a booking or a table is shown as, one word or two, in the list and on the plan. */
export type StageLabel = 'booked' | 'confirmed' | 'arrived' | 'seated' | 'left' | 'cancelled' | 'no_show' | 'held' | 'free';

export interface Messages {
  demo: {
    label: string;
    client: string;
    restaurant: string;
    sides: string;
    languages: string;
    note: string;
    /** What Maître is, beside its name in the bar on a wide screen, and after it in the site's title. */
    product: string;
    /** «Démo : vous gérez Merrain», before the restaurant's day and time on the restaurant's side. */
    manager: string;
    /** After the time, when the panel shows the next service: none is left today. */
    next: (weekday: string) => string;
    /** After the time, while the panel shows the recorded evening rather than the visitor's live restaurant. */
    notLive: string;
    skip: string;
    /** What the image a shared link shows says and shows, for those who cannot see it. */
    imageAlt: string;
  };
  live: {
    verify: string;
    verifyFailed: string;
    retry: string;
    expired: string;
    paused: string;
    offline: string;
    /** The live demo answered with something it should not have: out of order for now, and not the visitor's fault. */
    down: string;
    tooMany: string;
    tooFast: string;
    full: string;
    fresh: string;
    recorded: string;
    notSent: string;
    /** The panel's word when the live demo cannot open: it shows the evening in the browser instead. */
    local: string;
  };
  site: {
    title: string;
    description: string;
    sections: string;
    menuButton: string;
    menu: string;
    booking: string;
    hours: string;
    info: string;
    cellar: string;
    cellarNote: string;
    /** The cellar's selection, by where the wines grow. */
    cellarGroups: { left: string; right: string; whites: string };
    house: string;
    /** Two lines: the name, the cooking; the cellar has its own screen. */
    houseLines: readonly [string, string];
    groups: string;
    /** From how many guests a party is a group, read from the restaurant's largest table. */
    groupsText: (from: number) => string;
    groupsButton: string;
    /** The way down from the cover, the chevron: said to screen readers. */
    next: string;
    legal: string;
    book: string;
    /** The tab beside «Réserver» that calls the restaurant from the browser. */
    call: string;
    close: string;
    kind: string;
    place: string;
    rule: (days: number, noticeMinutes: number) => string;
    courses: Record<DishCategory, string>;
    prices: string;
    service: (name: string, from: string, to: string) => string;
    closed: string;
    weekdays: readonly [string, string, string, string, string, string, string];
    /**
     * Where the restaurant is, and its own day and time, as a phone shows the callee's: the demo lives in its
     * own evening, which can be evening there while it is afternoon here. In the chat's notice and on the call.
     */
    clock: (weekday: string, time: string) => string;
    days: (first: string, last: string) => string;
    footer: string;
  };
  chat: {
    title: string;
    /** Under the title while the live chat opens, once it is live (who answers, and that it is live), and when it cannot be. */
    status: { connecting: string; live: string; down: string };
    close: string;
    log: string;
    prompt: string;
    typing: string;
    you: string;
    booked: string;
    reference: (reference: string) => string;
    again: string;
    panel: string;
    replayFailed: string;
    phoneLabel: string;
    phoneHelp: string;
    phoneExample: string;
    phoneUnreadable: string;
    phoneSent: string;
    send: string;
    /** Under the restaurant's clock, said once and small: nothing real goes in, and all of it is deleted. */
    notice: string;
    /** Above the recorded conversations, said once and plainly: they are not the live chat. */
    recordedNotice: string;
    message: string;
    left: (count: number) => string;
    examples: string;
    /** The chips under the field, each filling it with its example. `book` names the evening. */
    chips: { book: (evening: string) => string; allergen: string };
    /**
     * Messages a visitor can start from. `book` asks for the first dinner still bookable, as the restaurant
     * suggests it: a guest's request, not a promise.
     */
    example: { book: (partySize: number, evening: string, time: string) => string; allergen: string; group: string };
    /** The suggested evening as a guest says it: the same day, the next, or a weekday further on. */
    evening: { today: string; tomorrow: string; on: (weekday: string) => string };
  };
  call: {
    /** The way in, under «Adresse et réservation»: shown only when the demo takes calls. */
    open: string;
    title: string;
    /** Said once and small, under «Appeler»: how long a call may last, and that the voice is not recorded. */
    terms: (minutes: number) => string;
    left: (count: number) => string;
    status: { connecting: string; ringing: string; live: string; ended: string };
    call: string;
    again: string;
    hangUp: string;
    /** When the browser held the restaurant's voice back until a click. */
    sound: string;
    /** The captions' switch, and their name. */
    captions: string;
    /** The microphone is on the line but hears nothing at all, as when it is muted; `choose` when there is another. */
    silent: (choose: boolean) => string;
    /** The microphone picker, once the browser has allowed the microphone and the computer has more than one. */
    device: string;
    /** When the restaurant takes no calls: the way to book in writing, above the site's own «Réserver». */
    written: string;
    /** `ask` lights the keypad when the restaurant wants the number; `sent` is the line the number becomes once # sends it. */
    keypad: { ask: string; typed: string; sent: (number: string) => string };
    problems: {
      micDenied: string;
      /** Missing, or held by another application. */
      micFailed: string;
      callLimit: (count: number) => string;
      rateLimited: string;
      paused: string;
      unavailable: string;
      line: string;
      /** The line rang and no restaurant picked up. */
      noAnswer: string;
    };
  };
  panel: {
    title: string;
    description: string;
    heading: string;
    fromChat: (name: string, channel: Channel, readBack: string) => string;
    callbackFromChat: (channel: Channel, summary: string) => string;
    search: string;
    walkIn: string;
    walkInAsk: string;
    dismiss: string;
    /** While the panel opens the visitor's restaurant, before its service shows. */
    opening: string;
    /** In the panel's bar: the first visit's tour, for anyone who wants to see it again. */
    tourAgain: string;
    /** A booking the staff take by hand, on the phone or at the door for another day. */
    booking: {
      open: string;
      date: string;
      time: string;
      partySize: string;
      name: string;
      phone: string;
      /** The language the guest speaks, for what the restaurant sends them later. */
      guestLanguage: string;
      /** Above the fourteen allergens, each ticked for the party as the assistant records them. */
      allergies: string;
      notes: string;
      /** After a field's label, when it can stay empty. */
      optional: string;
      submit: string;
      close: string;
      /** Above the times the restaurant offers instead, each a button that takes it. */
      instead: string;
      /** Today, once its last time to book has passed. */
      noTimeLeft: string;
      booked: (name: string, readBack: string) => string;
      /** Changing a booking: the sheet's name and its button, what it says once done, and why a field is closed. */
      editTitle: string;
      save: string;
      changed: (name: string, readBack: string) => string;
      arrived: string;
      /** Above the tables that would seat the booking, when its own no longer does. */
      freeTables: string;
      /** After the booking's own table, when it is among those free: at a new time it is a choice like the others. */
      currentTable: string;
      nameRequired: string;
    };
    /** The requests passed to the team, to call back and mark done. */
    /** The bookings the opening hours leave out, to call and to move or cancel. */
    outside: { title: (count: number) => string; help: (count: number) => string; show: string; hide: string; saved: (count: number) => string };
    callbacks: {
      title: string;
      empty: string;
      /** A link that dials the guest's number. */
      call: string;
      done: string;
      doneNotice: string;
      /** When the request came, and by which way. */
      when: (time: string, channel: Channel) => string;
    };
    tour: {
      label: string;
      step: (number: number, total: number) => string;
      next: string;
      skip: string;
      done: string;
      /** `next` when the panel opens on the next service, none being left today. */
      service: {
        title: string;
        body: (day: string, time: string) => string;
        next: (day: string, time: string, service: string) => string;
        /** The panel opened on another day, the night a booking from the chat is for: the button that comes back is named. */
        shown: (day: string, time: string, shown: string, back: string) => string;
      };
      room: { title: string; body: string };
      alerts: { title: string; body: string };
      /** The rail: the assistant's work and the settings; a recorded evening has the settings alone to show. */
      rail: { title: string; body: string; recorded: string };
    };
    /** The rail down the side; on the phone, a bar at the bottom. */
    sections: { label: string; service: string; conversations: string; activity: string; settings: string };
    /** The languages a guest may speak, named in the panel's own. */
    languages: Record<Language, string>;
    conversations: {
      title: string;
      list: string;
      /** None yet: how to have one, with the guest's side as the way there. */
      empty: string;
      choose: string;
      back: string;
      result: Record<ConversationResult, string>;
      passed: string;
      length: (seconds: number) => string;
      /** How a call ended, by who or what ended it, or that it is still going. */
      ended: Record<'caller' | 'goodbye' | 'silence' | 'time_limit' | 'paused' | 'error' | 'going', string>;
      /** A call's middle answer time. */
      answers: (time: string) => string;
      /**
       * What a turn did, as a line of the thread: a booking said as the guest heard it («une table pour 2 personnes le
       * jeudi 15 octobre à 20 h 30»), and a request passed to the team.
       */
      events: { booked: (booking: string) => string; changed: (booking: string) => string; cancelled: string; confirmed: string; passed: string };
      /** Behind it, closed until opened: what the assistant asked the engine, the rules the code kept, how fast, at what cost. */
      details: string;
      guest: string;
      assistant: string;
      /** The turn that followed a number typed in the chat's field or on the keypad, which the log never keeps. */
      typed: string;
      engine: string;
      /** The assistant's errands in the engine, and the engine's answers: an unknown one shows as the engine named it. */
      tools: Record<string, string>;
      statuses: Record<string, string>;
      corrected: string;
      corrections: Record<string, string>;
      /** A turn that could not be answered as it should. */
      outcomes: Record<string, string>;
      fellBack: string;
      latency: (time: string) => string;
      cost: (amount: string) => string;
    };
    activity: {
      title: string;
      period: string;
      periods: { today: string; week: string; month: string };
      range: (from: string, to: string) => string;
      calls: string;
      closedCalls: string;
      closedCallsOf: (answered: number) => string;
      closedCallsHelp: string;
      duringService: string;
      minutes: (count: number) => string;
      answerTime: string;
      answerTimeHelp: string;
      /** Nine answers in ten came within this. */
      p90: (time: string) => string;
      noCalls: string;
      bookings: string;
      bookingsHelp: string;
      byChannel: string;
      conversations: string;
      written: string;
      writtenHelp: string;
      turns: string;
      turnsHelp: string;
      passed: string;
    };
    settings: {
      title: string;
      hours: string;
      exceptions: string;
      noExceptions: string;
      bookings: string;
      slot: string;
      slotValue: (minutes: number) => string;
      notice: string;
      noticeValue: (minutes: number) => string;
      advance: string;
      advanceValue: (days: number) => string;
      party: string;
      partyValue: (size: number) => string;
      hold: string;
      holdValue: (minutes: number) => string;
      stays: string;
      stayValue: (size: number, minutes: number) => string;
      emptySeats: string;
      emptySeatsValue: (count: number) => string;
      menu: string;
      menuSummary: (dishes: number, undocumented: number) => string;
      menuHelp: string;
      /** A dish's sheet, one answer a line: the answer's word, then the allergens it holds for. */
      sheetLine: (answer: string, allergens: string) => string;
      contains: string;
      mayContain: string;
      /** «May contain» said short, where four answers sit side by side or one is the whole answer. */
      traces: string;
      free: string;
      unknown: string;
      /** The last line of a dish's sheet: every allergen the lines above do not name, or all of them. */
      freeRest: (count: number) => string;
      freeAll: (count: number) => string;
      /** One allergen checked across the menu: what an unstated answer means there. */
      unknownCheck: string;
      check: string;
      checkAll: string;
      /** A long «not stated» line, shown whole or cut to its first names. */
      showAll: string;
      showFewer: string;
      floor: string;
      tableGroup: (count: number, seats: number) => string;
      seatsTotal: (count: number) => string;
      zoneTables: (zone: string, tables: string) => string;
      waiters: string;
      waiterTables: (who: string, tables: string) => string;
      languages: string;
      defaultLanguage: string;
      languagesHelp: string;
      faq: string;
      /** Editing, on a restaurant that keeps what it is told: the recorded evening shows its settings without these. */
      edit: string;
      save: string;
      cancel: string;
      saved: string;
      /** The restaurant kept nothing: something the panel could not name stands in the way. */
      refused: string;
      firstTable: string;
      lastTable: string;
      /** Why a day's services cannot stand. */
      order: string;
      overlap: string;
      day: string;
      addDay: string;
      dayTaken: string;
      closedAllDay: string;
      specialHours: string;
      reason: string;
      reasonIncomplete: string;
      remove: string;
      noticeNone: string;
      advanceUnit: string;
      advanceRange: string;
      partyHelp: (largest: number) => string;
      addDish: string;
      editDish: (name: string) => string;
      dishName: string;
      allergens: string;
      category: string;
      price: string;
      priceUnreadable: string;
      nameMissing: string;
      removeDish: string;
      removeForGood: string;
      addQuestion: string;
      question: string;
      answer: string;
      textMissing: string;
    };
  };
  service: {
    now: (time: string) => string;
    previousDay: string;
    nextDay: string;
    /** Back to today's service from another day. */
    today: string;
    sittings: string;
    summary: (covers: number, bookings: number, service: string) => string;
    covers: (count: number) => string;
    bookings: (count: number) => string;
    counters: string;
    allergies: (count: number) => string;
    callbacks: (count: number) => string;
    holds: (count: number) => string;
    views: string;
    plan: string;
    list: string;
    room: string;
    entrance: string;
    kitchen: string;
    flow: string;
    curve: string;
    curveLabel: (peak: number, peakAt: string, seats: number) => string;
    /** The curve's highest point, written over it: «32 à 20:30». */
    peak: (covers: number, time: string) => string;
    groups: Record<GroupId, string>;
    stage: Record<StageLabel, string>;
    late: (minutes: number) => string;
    freeAt: (time: string) => string;
    movedFrom: (time: string) => string;
    walkIn: string;
    newBooking: string;
    channel: Record<Channel, string>;
    table: (number: string) => string;
    /** A free table's card: «Table 11, libre». */
    freeTitle: (number: string) => string;
    seats: (count: number) => string;
    allergy: string;
    waiter: (name: string) => string;
    note: string;
    nextBooking: (name: string, time: string) => string;
    /** After the name and time of the party a free table waits for, on the plan. */
    upNext: string;
    holdDetail: (partySize: number, time: string, until: string) => string;
    close: string;
    markArrived: string;
    seatAt: (table: string) => string;
    freeTable: string;
    /** The host moves a booking to another table, where the engine keeps it. */
    moveTable: string;
    /** On a booking's card: change it, or settle «À confirmer» with the guest. */
    edit: string;
    confirmBooking: string;
    noOtherTable: string;
    /** A booking still to come that the opening hours now leave out. */
    outsideHours: string;
    /** On today's table card, the parties due after the next one. */
    later: string;
    moveTo: string;
    movedTo: (name: string, table: string) => string;
    cancel: string;
    noShow: string;
    /** The second step of a cancellation or a no-show: one click undoes nothing. */
    confirmCancel: string;
    confirmNoShow: string;
    back: string;
    walkInAsk: string;
    /** Outside every arrival window: the engine seats a party at the door only inside one. */
    walkInClosed: string;
    walkInSize: (count: number) => string;
    done: (name: string, stage: string) => string;
    seatedAt: (name: string, table: string) => string;
    refusal: Record<StaffRefusal, string>;
    notFound: string;
    tableTaken: (free: readonly string[]) => string;
    unknownTable: string;
    unavailable: Record<UnavailableReason, string>;
    alternatives: (times: readonly string[]) => string;
    invalid: string;
    empty: string;
    noMatch: (query: string) => string;
  };
  legal: {
    title: string;
    description: string;
    heading: string;
    back: string;
    /** `contact`: the section ends with the publisher's links. */
    sections: readonly { heading: string; body: string; contact?: boolean }[];
  };
  notFound: {
    title: string;
    heading: string;
    body: string;
    back: string;
  };
}

const MESSAGES: Record<Language, Messages> = { fr, en, es };

export function messagesFor(language: Language): Messages {
  return MESSAGES[language];
}
