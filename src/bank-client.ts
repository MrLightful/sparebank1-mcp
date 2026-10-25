import { API_ORIGIN } from './config.js';
import type { Config } from './config.js';
import { operation } from './operation.js';
import { Auth } from './auth.js';
import { BankingError } from './errors.js';
import { boundedText, retryAfter } from './http.js';
import type { Fetch } from './http.js';

export type Query = Record<string, string | number | boolean | string[] | undefined>;
export interface Request {
  path: string;
  version: 1 | 5;
  method?: 'GET' | 'POST';
  query?: Query;
  body?: unknown;
  format?: 'json' | 'csv';
  mutation?: boolean;
}

export class BankClient {
  constructor(
    readonly config: Config,
    readonly auth: Auth,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async request(request: Request): Promise<unknown> {
    if (
      !/^\/(personal\/banking\/|common\/helloworld$)/.test(request.path) ||
      request.path.includes('..') ||
      request.path.includes('?') ||
      request.path.includes('#')
    ) {
      throw new BankingError('INVALID_PATH', 'Invalid bank API path.');
    }
    const url = new URL(request.path, API_ORIGIN);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined)
        for (const item of Array.isArray(value) ? value : [value])
          url.searchParams.append(key, String(item));
    }
    const cancellation = operation.getStore()?.signal;
    const ensureActive = () => {
      if (cancellation?.aborted)
        throw new BankingError('REQUEST_CANCELLED', 'Request was cancelled before submission.');
    };
    ensureActive();
    let token = await this.auth.accessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      ensureActive();
      let response: Response;
      let text: string;
      const mediaType = `application/vnd.sparebank1.v${request.version}+json; charset=utf-8`;
      try {
        response = await this.fetcher(url, {
          method: request.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: request.format === 'csv' ? 'application/csv;charset=UTF-8' : mediaType,
            ...(request.body === undefined ? {} : { 'Content-Type': mediaType }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          redirect: 'error',
          signal: AbortSignal.any([
            AbortSignal.timeout(this.config.timeoutMs),
            ...(cancellation ? [cancellation] : []),
          ]),
        });
        text = await boundedText(response);
      } catch (error) {
        if (!request.mutation && error instanceof BankingError) throw error;
        throw new BankingError(
          request.mutation ? 'TRANSFER_OUTCOME_UNKNOWN' : 'BANK_UNAVAILABLE',
          request.mutation
            ? 'The transfer response could not be received. Its outcome is unknown.'
            : 'The bank request timed out or could not be completed.',
          undefined,
          undefined,
          Boolean(request.mutation),
        );
      }
      // Replay only reads, including POST /accounts/balance. Never replay a transfer.
      if (response.status === 401 && !request.mutation && attempt === 0) {
        token = await this.auth.accessToken(token);
        continue;
      }
      if (!response.ok) {
        const codes = this.bankCodes(text);
        const unknown = Boolean(
          request.mutation &&
          (response.status >= 500 ||
            response.status === 408 ||
            (response.status >= 300 && response.status < 400)),
        );
        const message = unknown
          ? 'The bank returned an error after submission; the transfer outcome may be unknown.'
          : response.status === 401
            ? 'Authorization rejected. Run login again before continuing.'
            : response.status === 403
              ? 'The bank denied access or the operation is not allowed for this account.'
              : response.status === 429
                ? 'The bank rate limit was reached. Wait before making another request.'
                : 'The bank rejected the request. Check the supplied identifiers and parameters.';
        throw new BankingError(
          unknown ? 'TRANSFER_OUTCOME_UNKNOWN' : `BANK_HTTP_${response.status}`,
          message,
          response.status,
          retryAfter(response.headers.get('retry-after')),
          unknown,
          codes,
        );
      }
      if (request.format === 'csv') return { csv: text };
      if (!text.trim()) {
        throw new BankingError(
          request.mutation ? 'TRANSFER_OUTCOME_UNKNOWN' : 'BANK_INVALID_RESPONSE',
          'The bank returned an empty response.',
          response.status,
          undefined,
          Boolean(request.mutation),
        );
      }
      try {
        const data: unknown = JSON.parse(text);
        if (typeof data !== 'object' || data === null || Array.isArray(data))
          throw new Error('object required');
        return data;
      } catch {
        throw new BankingError(
          request.mutation ? 'TRANSFER_OUTCOME_UNKNOWN' : 'BANK_INVALID_RESPONSE',
          'The bank returned an unexpected response.',
          response.status,
          undefined,
          Boolean(request.mutation),
        );
      }
    }
    throw new BankingError('AUTH_REQUIRED', 'Authorization failed. Run login again.');
  }

  private bankCodes(text: string): string[] {
    try {
      const body = JSON.parse(text) as { errors?: { code?: unknown }[] };
      return Array.isArray(body.errors)
        ? body.errors
            .flatMap((e) =>
              typeof e?.code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(e.code) ? [e.code] : [],
            )
            .slice(0, 10)
        : [];
    } catch {
      return [];
    }
  }
}
