import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod/v4';

export const API_ORIGIN = 'https://api.sparebank1.no';
export const VERSION = '0.0.1';

const secret = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[^\r\n]+$/);
const envSchema = z.object({
  SB1_CLIENT_ID: secret.optional(),
  SB1_CLIENT_SECRET: secret.optional(),
  SB1_REDIRECT_URI: z.url().optional(),
  SB1_FIN_INST: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
  SB1_ACCESS_TOKEN: secret.optional(),
  SB1_TOKEN_FILE: z.string().min(1).optional(),
  SB1_ENABLE_TRANSFERS: z.enum(['true', 'false']).default('false'),
  SB1_MAX_TRANSFER_AMOUNT: z
    .string()
    .regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/)
    .default('10000.00'),
  SB1_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
});

export interface Config {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  finInst?: string;
  accessToken?: string;
  tokenFile: string;
  enableTransfers: boolean;
  maxTransferMinor: bigint;
  timeoutMs: number;
}

export function toMinor(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Never stringify validation input: it may contain credentials.
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}. See .env.example.`,
    );
  }
  const e = parsed.data;
  if (toMinor(e.SB1_MAX_TRANSFER_AMOUNT) <= 0n)
    throw new Error('SB1_MAX_TRANSFER_AMOUNT must be positive.');
  if (e.SB1_REDIRECT_URI) validateRedirect(e.SB1_REDIRECT_URI);
  const path = e.SB1_TOKEN_FILE ?? join(homedir(), '.config', 'sparebank1-mcp', 'tokens.json');
  return {
    ...(e.SB1_CLIENT_ID ? { clientId: e.SB1_CLIENT_ID } : {}),
    ...(e.SB1_CLIENT_SECRET ? { clientSecret: e.SB1_CLIENT_SECRET } : {}),
    ...(e.SB1_REDIRECT_URI ? { redirectUri: e.SB1_REDIRECT_URI } : {}),
    ...(e.SB1_FIN_INST ? { finInst: e.SB1_FIN_INST } : {}),
    ...(e.SB1_ACCESS_TOKEN ? { accessToken: e.SB1_ACCESS_TOKEN } : {}),
    tokenFile: isAbsolute(path) ? path : resolve(path),
    enableTransfers: e.SB1_ENABLE_TRANSFERS === 'true',
    maxTransferMinor: toMinor(e.SB1_MAX_TRANSFER_AMOUNT),
    timeoutMs: e.SB1_REQUEST_TIMEOUT_MS,
  };
}

export function validateRedirect(uri: string): URL {
  const url = new URL(uri);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error(
      'SB1_REDIRECT_URI must use HTTPS or loopback HTTP, without credentials, query, or fragment.',
    );
  }
  return url;
}

export function requireOAuth(config: Config): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error(
      'Set SB1_CLIENT_ID, SB1_CLIENT_SECRET and SB1_REDIRECT_URI, then run sparebank1-mcp login.',
    );
  }
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  };
}
