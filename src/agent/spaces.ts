/**
 * Replaces each run of spaces that comes right before one of `marks` with `by`, the mark
 * kept, in a single pass. A regular expression such as /\s+([.,!?])/g does the same, but
 * on a long run of spaces followed by no mark it starts again from each of its spaces:
 * quadratic on a reply written to be slow.
 */
export function spaceBefore(text: string, isSpace: (char: string) => boolean, marks: string, by: string): string {
  let out = '';
  let run = '';
  for (const char of text) {
    if (isSpace(char)) {
      run += char;
      continue;
    }
    out += (run !== '' && marks.includes(char) ? by : run) + char;
    run = '';
  }
  return out + run;
}

/** Whether a character is one a regular expression's \s matches. */
export const isWhitespace = (char: string): boolean => /\s/.test(char);
