/**
 * The services behind the demo, as the legal page names them in its three languages: a provider that changes is
 * changed here, once.
 */
export const PROVIDERS = {
  host: 'Cloudflare, Inc., 101 Townsend Street, San Francisco, CA 94107',
  botCheck: 'Cloudflare Turnstile',
  model: 'Claude Haiku',
  modelMaker: 'Anthropic',
  router: 'OpenRouter',
  /** Where OpenRouter calls the model, in its order: Europe, then Ireland; the model's maker only if both fail. */
  modelHosts: ['Google Vertex', 'AWS'],
  /** The call's line, the server the voice agent runs on, and who hears the caller and who speaks the replies. */
  line: 'LiveKit',
  agentHost: 'Hetzner Online',
  transcription: 'Deepgram',
  voice: 'Cartesia',
} as const;
