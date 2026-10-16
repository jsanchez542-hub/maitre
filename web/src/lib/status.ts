import { LiveError, readDemoStatus, type DemoStatus } from './live';

let asked: Promise<DemoStatus | null> | undefined;

/**
 * Whether the live demo is open, asked once a page by the chat, the panel and the call. Null when the Worker could
 * not say: the chat then tries and explains what it meets, and no call is offered.
 */
export function demoStatus(): Promise<DemoStatus | null> {
  asked ??= readDemoStatus().catch((error: unknown) => {
    if (error instanceof LiveError) return null;
    throw error;
  });
  return asked;
}
