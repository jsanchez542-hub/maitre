import type { ToolOutput } from '../tools.js';

/** Collapses every kind of space, apostrophe and quotation mark, so a comparison is about words, not typography. */
export function comparable(text: string): string {
  return text
    .replace(/[    \s]+/g, ' ')
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[«»"“”]/g, '"')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/"\s+/g, '"')
    .replace(/\s+"/g, '"')
    .trim()
    .toLowerCase();
}

/** Sentences of a text, split after a full stop, question or exclamation mark. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordsOf(text: string): string[] {
  return comparable(text)
    .replace(/[^\p{L}\p{N}' ]/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

/**
 * Whether a sentence of the model's only says again what an exact sentence
 * says: nearly all its words, and no more than three of its own. "The allergen
 * sheet for the chocolate mousse…" restates "The allergen sheet for “Chocolate
 * mousse”…"; a sentence that adds a reason or a second dish does not.
 */
function restates(sentence: string, exact: string): boolean {
  const said = wordsOf(sentence);
  const target = wordsOf(exact);
  if (target.length === 0) return false;
  const saidSet = new Set(said);
  const targetSet = new Set(target);
  const covered = target.filter((word) => saidSet.has(word)).length / target.length;
  const added = said.filter((word) => !targetSet.has(word)).length;
  return covered >= 0.9 && added <= 3;
}

/** A title that says whether someone is a man or a woman, in the three languages; "M." is French for monsieur. */
const ONE_TITLE = '(?:[Mm]onsieur|[Mm]adame|[Mm]ademoiselle|Mme|Mlle|Mrs|Mr|Ms|Miss|[Ss]e[ñn]orita|[Ss]e[ñn]ora|[Ss]e[ñn]or|Srta|Sra|Sr|M(?=\\.))\\.?';
/**
 * One title, or the model hedging with two ("Mr or Ms", "monsieur ou madame", "señor/señora"),
 * never inside a word or an abbreviation ("8 P.M. Merci" keeps its M.).
 */
const TITLE = `(?<![\\p{L}.\\-])${ONE_TITLE}(?:(?:\\s*/\\s*|\\s+(?:or|ou|o)\\s+)${ONE_TITLE})?`;
/** A surname as the guest gave it: one or two capitalised words. */
const NAME = "\\p{Lu}[\\p{L}'’-]*(?: \\p{Lu}[\\p{L}'’-]*)?";
const VOCATIVE_AT_END = new RegExp(`,\\s*${TITLE}\\s+${NAME}(?=\\s*(?:[.!?,;:…]|$))`, 'gu');
const VOCATIVE_AT_START = new RegExp(`(^|[.!?]\\s+)${TITLE}\\s+${NAME}\\s*,\\s*(\\p{Ll})`, 'gu');
const TITLED_NAME = new RegExp(`${TITLE}\\s+(${NAME})`, 'gu');

/**
 * The guest only ever gives a surname, so a title guesses whether they are a
 * man or a woman. The prompt says so, and the model still wrote "Your table is
 * booked, Ms Clarke" or "De nada, señor Navarro" in the web run of 12 October,
 * once calling "monsieur" a woman who had mentioned her husband. The title and
 * the name go when they address the guest ("Merci, monsieur Mercier." becomes
 * "Merci."); anywhere else the title goes and the name stays.
 */
export function dropGuessedTitles(reply: string): { reply: string; corrected: boolean } {
  const text = reply
    .replace(VOCATIVE_AT_END, '')
    .replace(VOCATIVE_AT_START, (_match, start: string, first: string) => `${start}${first.toUpperCase()}`)
    .replace(TITLED_NAME, '$1');
  return { reply: text, corrected: text !== reply };
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Told to use no title, the model sometimes addresses the guest by the bare
 * surname instead ("Thank you, Clarke.", "De nada, Navarro."), which reads as
 * curt in every language. The names it booked under go when they address the
 * guest; "under the name Clarke" and "a nombre de Navarro" stay.
 */
export function dropNameVocatives(reply: string, names: readonly string[]): { reply: string; corrected: boolean } {
  let text = reply;
  for (const name of new Set(names.map((candidate) => candidate.trim()).filter(Boolean))) {
    const quoted = escaped(name);
    text = text
      .replace(new RegExp(`,\\s*${quoted}(?=\\s*[.!?:;,…]|$)`, 'gu'), '')
      .replace(new RegExp(`(^|[.!?]\\s+)${quoted}\\s*,\\s*(\\p{Ll})`, 'gu'), (_match, start: string, first: string) => `${start}${first.toUpperCase()}`);
  }
  return { reply: text, corrected: text !== reply };
}

/**
 * A reply that tells the guest their request is with the team: "j'ai transmis
 * votre demande", "the team will call you back", "he pasado su solicitud al
 * equipo". Questions and offers ("Souhaitez-vous que je transmette… ?", "Si
 * vous le souhaitez…") promise nothing yet and do not count.
 */
const PROMISES: readonly RegExp[] = [
  /\b(je (vous )?(transmets|fais suivre)|j['’]ai (bien )?(transmis|fait suivre)|votre (demande|question|message) (est|a été|a bien été) (transmise?|envoyée?)|l['’]équipe (va |vous )*(vous )?(rappeler|rappellera|recontacter|recontactera|contacter|contactera|reviendra vers vous))/i,
  /\b(i['’]ve (just )?passed|i have (just )?passed|i['’]m passing|i am passing|i['’]ll pass|i will pass|(your request|your question|it) (has been|is being|was) passed|the team will (call|get back|contact|be in touch)|someone (from the team )?will (call|get back|contact))/i,
  /\b(he pasado|he trasladado|he enviado|paso (su|tu) (solicitud|petici[oó]n|consulta)|traslado (su|tu)|(su|tu) (solicitud|petici[oó]n|consulta) (ha sido|fue) (trasladada|enviada|pasada)|el equipo (le |te )?(llamar[áa]|contactar[áa]|se pondr[áa] en contacto))/i,
];
const OFFER = /^\s*(si|if)\b|souhaitez-vous|voulez-vous|would you like|do you want|¿?\s*desea|¿?\s*quiere/i;

/** Whether a reply tells the guest, without asking, that the team has their request. */
export function promisesTeam(reply: string): boolean {
  return sentencesOf(reply).some((sentence) => !sentence.includes('?') && !OFFER.test(sentence) && PROMISES.some((promise) => promise.test(sentence)));
}

/** Every booking reference in the tools' answers, wherever it sits in them. */
export function referencesIn(outputs: readonly unknown[]): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'reference' && typeof inner === 'string' && /^[A-Z0-9]{4,12}$/.test(inner)) found.add(inner);
        else visit(inner);
      }
    }
  };
  outputs.forEach(visit);
  return [...found];
}

/**
 * On the phone a booking reference is noise: letters and digits the caller
 * cannot write down while listening, and that speech synthesis reads badly.
 * The prompt says so, and the model still said "Votre référence est 3PYPJA."
 * in the first live call. The sentences that read one out go, spelled or not;
 * a reply that would be left empty is kept as it was.
 */
export function dropSpokenReferences(reply: string, references: readonly string[]): { reply: string; corrected: boolean } {
  if (references.length === 0) return { reply, corrected: false };
  const spelled = references.map((reference) => [...reference].map(escaped).join('[\\s.,\\-‑]*'));
  const spoken = spelled.map((pattern) => new RegExp(pattern, 'i'));
  // "…, référence A4XXCE", "sous la référence WT9DEW", "your reference is 3PYPJA": the mention, and only it.
  const mentions = spelled.map(
    (pattern) =>
      new RegExp(
        `(?:,\\s*|\\s+|^)(?:(?:sous|avec|with|under|con|bajo)\\s+)?(?:(?:la|le|votre|your|the|su|el|its)\\s+)?(?:booking\\s+)?(?:référence|reference|referencia|réf\\.?|ref\\.?)(?:\\s+(?:de\\s+(?:la\\s+)?(?:réservation|reserva)|number|número))?(?:\\s+(?:est|is|es|sera|will be))?\\s*:?\\s*(?:«\\s*)?${pattern}(?:\\s*»)?`,
        'giu',
      ),
  );
  const sentences = sentencesOf(reply);
  const said = sentences.flatMap((sentence) => {
    if (!spoken.some((pattern) => pattern.test(sentence))) return [sentence];
    // A sentence that opens with the reference is about it ("Votre référence est 4XKZ2P, notez-la."): it goes whole.
    if (mentions.some((mention) => sentence.search(new RegExp(mention.source, 'iu')) === 0)) return [];
    const without = mentions
      .reduce((text, mention) => text.replace(mention, ''), sentence)
      .replace(/\s+([.,!?;:…])/g, '$1')
      .replace(/^[\s,;:]+/, '')
      .trim();
    // What is left is kept when it still says something and no longer reads the reference.
    const words = without.split(/\s+/).filter((word) => /\p{L}/u.test(word));
    return words.length >= 3 && !spoken.some((pattern) => pattern.test(without)) ? [without] : [];
  });
  const text = said.join(' ');
  if (text === '' || text === sentences.join(' ')) return { reply, corrected: false };
  return { reply: text, corrected: true };
}

/**
 * Allergen answers must reach the guest word for word. The tool hands the model
 * the sentences to repeat, and the model usually does; when it does not, the
 * exact sentences go first, and the model's own sentences that only restate
 * them are dropped so the guest does not read the same thing twice. Everything
 * else the model wrote is kept, so a reply that also answered something else
 * still does.
 */
export function enforceAllergenRelay(
  reply: string,
  tools: readonly { name: string; output: ToolOutput }[],
): { reply: string; corrected: boolean } {
  const sentences = tools
    .filter((tool) => tool.name === 'check_dish' && tool.output.status === 'ok')
    .flatMap((tool) => (Array.isArray(tool.output['sayExactly']) ? (tool.output['sayExactly'] as unknown[]) : []))
    .filter((sentence): sentence is string => typeof sentence === 'string');
  const unique = [...new Set(sentences)];
  const target = comparable(reply);
  if (unique.every((sentence) => target.includes(comparable(sentence)))) return { reply, corrected: false };

  const exact = unique.flatMap(sentencesOf);
  const rest = reply
    .split(/\n{2,}/)
    .map((paragraph) =>
      sentencesOf(paragraph)
        .filter((sentence) => !exact.some((candidate) => restates(sentence, candidate)))
        .join(' '),
    )
    .filter(Boolean);
  return { reply: [unique.join(' '), ...rest].join('\n\n').trim(), corrected: true };
}
