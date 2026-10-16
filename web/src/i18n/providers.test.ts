import type { Language } from 'maitre';
import { describe, expect, it } from 'vitest';
import { messagesFor } from './messages';
import { PROVIDERS } from './providers';

const LANGUAGES: readonly Language[] = ['fr', 'en', 'es'];

describe('the legal page', () => {
  it('names every service behind the demo, in each language, from the one list', () => {
    const names = [PROVIDERS.host, PROVIDERS.botCheck, PROVIDERS.model, PROVIDERS.modelMaker, PROVIDERS.router, ...PROVIDERS.modelHosts, PROVIDERS.line, PROVIDERS.agentHost, PROVIDERS.transcription, PROVIDERS.voice];
    for (const language of LANGUAGES) {
      const page = messagesFor(language)
        .legal.sections.map((section) => section.body)
        .join(' ');
      for (const name of names) expect(page, `${language}: ${name}`).toContain(name);
    }
  });
});
