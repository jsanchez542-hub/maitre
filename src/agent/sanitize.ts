import type { Language } from '../i18n/index.js';
import type { Channel } from '../store.js';

const THIN = ' ';

/**
 * French puts a narrow no-break space before ? ! ; : and inside « ». Models
 * write a plain space or none at all. A colon is only fixed when a space is
 * already there, so 20:30 and web addresses are never touched. A sentence the
 * engine wrote already has its narrow spaces, and keeps exactly one.
 *
 * A time comes to the model as "21 h 30" with no-break spaces, and copying it
 * the model sometimes drops the space after it ("21 h 30est disponible"): the
 * space comes back.
 */
export function frenchSpacing(text: string): string {
  return text
    .replace(/[   ]+([?!;:»])/g, `${THIN}$1`)
    .replace(/([^\s  \d/=&?!])([?!;»])/g, `$1${THIN}$2`)
    .replace(/«[   ]*/g, `«${THIN}`)
    .replace(/(\d{1,2}[   ]h[   ]\d{2})(?=\p{L})/gu, '$1 ');
}

/**
 * The last step before a reply reaches a guest. Prompts ask for plain text,
 * but models still slip into markdown and dashes now and then; this removes
 * them deterministically instead of hoping the prompt holds. On the phone,
 * where text becomes speech, line breaks and emoji go as well.
 */
export function sanitizeReply(text: string, channel: Channel, language?: Language): string {
  // Bold markers are removed by splitting, not by a regular expression: linear
  // on any input, and nothing in a reply needs a literal ** or __.
  let reply = text.replace(/\r\n?/g, '\n').split('**').join('').split('__').join('');

  const lines = reply.split('\n').map((line) => {
    let clean = line.trimEnd();
    while (clean.startsWith('#')) clean = clean.slice(1);
    const trimmed = clean.trimStart();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
      clean = channel === 'voice' ? trimmed.slice(2) : `• ${trimmed.slice(2)}`;
    }
    return clean.trim();
  });
  reply = lines.join('\n');

  // A dash between figures is a range (12h–14h) and keeps a plain hyphen;
  // anywhere else it was a pause, and a comma reads better.
  reply = reply.replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2').replace(/\s*[–—]\s*/g, ', ');

  if (channel === 'voice') {
    reply = reply.replace(/\p{Extended_Pictographic}️?/gu, '').replace(/\n+/g, ' ');
  }

  reply = reply
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ,/g, ',')
    .replace(/,{2,}/g, ',')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return language === 'fr' ? frenchSpacing(reply) : reply;
}
