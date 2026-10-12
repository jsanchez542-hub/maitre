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
