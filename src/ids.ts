/** Where identifiers come from. The tests pass a predictable one. */
export interface IdSource {
  /** An opaque unique id for records. */
  id(): string;
  /** A short booking reference a guest can read out or type. */
  reference(): string;
}

/**
 * No 0/O, 1/I/L, 2/Z, 5/S, 6/G or 8/B: characters that are misread on a screen
 * or misheard on the phone.
 */
export const REFERENCE_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';
export const REFERENCE_LENGTH = 6;

interface WebCrypto {
  randomUUID(): string;
  getRandomValues<T extends Uint8Array>(array: T): T;
}

// The engine runs in Node, in browsers and in Cloudflare Workers, which all
// expose Web Crypto on globalThis. Read it there instead of declaring a global
// type, so the core does not depend on DOM or Node type definitions.
function webCrypto(): WebCrypto {
  const crypto = (globalThis as unknown as { crypto?: WebCrypto }).crypto;
  if (!crypto) throw new Error('Web Crypto is not available in this runtime');
  return crypto;
}

/** Uniform choice from the alphabet: bytes that would favour some characters are thrown away. */
function randomReference(): string {
  const crypto = webCrypto();
  const size = REFERENCE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let reference = '';
  while (reference.length < REFERENCE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte >= limit) continue;
      reference += REFERENCE_ALPHABET[byte % size];
      if (reference.length === REFERENCE_LENGTH) break;
    }
  }
  return reference;
}

export const randomIds: IdSource = {
  id: () => webCrypto().randomUUID(),
  reference: randomReference,
};

export function isReference(value: string): boolean {
  if (value.length !== REFERENCE_LENGTH) return false;
  for (const char of value) if (!REFERENCE_ALPHABET.includes(char)) return false;
  return true;
}
