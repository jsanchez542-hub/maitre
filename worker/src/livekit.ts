/**
 * The pass a browser needs to call the restaurant through LiveKit: a JSON Web
 * Token signed with the project's secret, which lets one person into one room,
 * with a microphone and nothing else, and has the voice agent sent to that room.
 *
 * Signed here with Web Crypto rather than with LiveKit's SDK, which would add a
 * dependency to the Worker for one HMAC.
 */

export interface LiveKitProject {
  /** wss://<project>.livekit.cloud */
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface CallPass {
  room: string;
  /** Who the visitor is in the room. Never a name or a number: nothing about the person. */
  identity: string;
  /** The agent LiveKit sends to the room, and what it is told about the call. */
  agentName: string;
  agentMetadata: string;
  /** How long the pass may be used to join, in seconds. */
  ttlSeconds: number;
  /** Seconds since the epoch, injected so tests are predictable. */
  now?: number;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

export async function callPass(project: LiveKitProject, pass: CallPass): Promise<string> {
  const now = pass.now ?? Math.floor(Date.now() / 1000);
  const claims = {
    iss: project.apiKey,
    sub: pass.identity,
    nbf: now,
    exp: now + pass.ttlSeconds,
    video: {
      room: pass.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      // The keypad's tones travel as data packets.
      canPublishData: true,
      canPublishSources: ['microphone'],
    },
    roomConfig: { agents: [{ agentName: pass.agentName, metadata: pass.agentMetadata }] },
  };
  const unsigned = `${base64urlJson({ alg: 'HS256', typ: 'JWT' })}.${base64urlJson(claims)}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(project.apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}

/** The project, when the deployment has all three settings: otherwise calls are not configured. */
export function liveKitProject(env: { LIVEKIT_URL?: string; LIVEKIT_API_KEY?: string; LIVEKIT_API_SECRET?: string }): LiveKitProject | undefined {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: apiSecret } = env;
  if (!url || !apiKey || !apiSecret || !/^wss:\/\/[A-Za-z0-9.-]+$/.test(url)) return undefined;
  return { url, apiKey, apiSecret };
}
