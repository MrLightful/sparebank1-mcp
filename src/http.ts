import { BankingError } from './errors.js';

export type Fetch = typeof globalThis.fetch;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BankingError(
          'RESPONSE_TOO_LARGE',
          'Bank response exceeds 4 MiB. Narrow the date range or row limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value), 3600);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(Math.max(0, Math.ceil((date - now) / 1000)), 3600)
    : undefined;
}
