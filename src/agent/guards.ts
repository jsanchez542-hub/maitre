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

/**
 * Allergen answers must reach the guest word for word. The tool hands the model
 * the sentences to repeat, and the model usually does; when it rephrases them
 * instead, even faithfully, the exact sentences are put in front of its reply.
 * Nothing is removed, so a reply that also answered something else keeps it.
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
  const missing = unique.filter((sentence) => !target.includes(comparable(sentence)));
  if (missing.length === 0) return { reply, corrected: false };
  return { reply: `${missing.join(' ')}\n\n${reply}`.trim(), corrected: true };
}
