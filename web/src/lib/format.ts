import type { Language } from 'maitre';
import { NNBSP } from './typography';

/** A time measured in milliseconds as the panel says it, to the tenth: «2,4 s», «2.4 s». */
export function secondsOf(ms: number, language: Language): string {
  const value = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000);
  return `${value}${NNBSP}s`;
}

/** What a turn cost, in the dollars the model is billed in, to the hundredth of a cent. */
export function dollarsOf(amount: number, language: Language): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(amount);
}
