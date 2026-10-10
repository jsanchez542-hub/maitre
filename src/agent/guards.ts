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
