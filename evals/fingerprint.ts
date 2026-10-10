import { createHash } from 'node:crypto';
import type { BusinessConfig } from '../src/config.js';

/**
 * A short fingerprint of what a restaurant's guests can be told: name, menu,
 * hours, tables and answers. Recorded conversations carry the fingerprint of
 * the restaurant they talked about, so a test can tell when they describe one
 * that no longer exists.
 *
 * The floor plan and the waiters are left out: only the staff see them, and no
 * reply of the assistant depends on them.
 */
export function restaurantFingerprint(config: BusinessConfig): string {
  const { floor: _floor, waiters: _waiters, ...told } = config;
  return createHash('sha256').update(JSON.stringify(told)).digest('hex').slice(0, 16);
}
