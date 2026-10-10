import { createHash } from 'node:crypto';
import type { BusinessConfig } from '../src/config.js';

/**
 * A short fingerprint of a restaurant's whole configuration: name, menu,
 * hours, tables and answers. Recorded conversations carry the fingerprint of
 * the restaurant they talked about, so a test can tell when they describe one
 * that no longer exists.
 */
export function restaurantFingerprint(config: BusinessConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}
