import { z } from 'zod/v4';
import { API_ORIGIN, requireOAuth } from './config.js';
import type { Config } from './config.js';
import { BankingError } from './errors.js';
import { boundedText } from './http.js';
import type { Fetch } from './http.js';
import { TokenStore } from './token-store.js';
import type { Tokens } from './token-store.js';

const responseSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().max(31536000),
  token_type: z.string().refine((s) => s.toLowerCase() === 'bearer'),
});

export class Auth {
  readonly store: TokenStore;
  private refreshFlight: Promise<string> | undefined;
  constructor(
    readonly config: Config,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.store = new TokenStore(config.tokenFile);
  }

  async status(): Promise<Record<string, unknown>> {
    if (this.config.accessToken)
      return { mode: 'environment', authenticated: true, expiresAt: null, automaticRefresh: false };
    const tokens = await this.store.read();
    if (tokens && this.config.clientId && tokens.clientId !== this.config.clientId) {
      throw new BankingError(
        'TOKEN_CLIENT_MISMATCH',
        'Saved tokens belong to a different client. Run login with the configured client.',
      );
    }
    return {
      mode: 'managed',
      authenticated: Boolean(tokens),
      expiresAt: tokens ? new Date(tokens.expiresAt).toISOString() : null,
      expired: tokens ? tokens.expiresAt <= Date.now() : null,
      automaticRefresh: Boolean(
        tokens?.refreshToken && this.config.clientId && this.config.clientSecret,
      ),
      action: tokens
        ? 'Authentication status is local; use sb1_check_connection to verify access with the bank.'
        : 'Run sparebank1-mcp login in a local terminal.',
    };
  }

  async accessToken(rejectedToken?: string): Promise<string> {
    if (this.config.accessToken) {
      if (rejectedToken)
        throw new BankingError(
          'AUTH_REQUIRED',
          'The environment access token was rejected. Replace SB1_ACCESS_TOKEN or use managed login.',
        );
      return this.config.accessToken;
    }
    const tokens = await this.store.read();
    if (!tokens)
      throw new BankingError(
        'AUTH_REQUIRED',
        'No saved login. Run sparebank1-mcp login in a local terminal.',
      );
    this.checkClient(tokens);
    if (tokens.expiresAt > Date.now() + 30000 && tokens.accessToken !== rejectedToken)
      return tokens.accessToken;
    if (!this.refreshFlight) {
      this.refreshFlight = this.store
        .locked(async () => {
          const latest = await this.store.read();
          if (!latest)
            throw new BankingError('AUTH_REQUIRED', 'Login was removed. Run login again.');
          this.checkClient(latest);
          if (latest.expiresAt > Date.now() + 30000 && latest.accessToken !== rejectedToken)
            return latest.accessToken;
          if (!latest.refreshToken || !this.config.clientId || !this.config.clientSecret)
            throw new BankingError(
              'AUTH_REQUIRED',
              'Login expired. Configure client credentials and run login again.',
            );
          const next = await this.requestToken(
            new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: latest.refreshToken,
              client_id: this.config.clientId,
              client_secret: this.config.clientSecret,
            }),
            latest.refreshToken,
          );
          await this.store.write(next);
          return next.accessToken;
        })
        .finally(() => {
          this.refreshFlight = undefined;
        });
    }
    return this.refreshFlight;
  }

  private checkClient(tokens: Tokens): void {
    if (this.config.clientId && tokens.clientId !== this.config.clientId)
      throw new BankingError(
        'TOKEN_CLIENT_MISMATCH',
        'Saved tokens belong to a different client. Run login again.',
      );
  }

  async exchangeCode(code: string, state: string): Promise<void> {
    const { clientId, clientSecret, redirectUri } = requireOAuth(this.config);
    await this.store.locked(async () => {
      const tokens = await this.requestToken(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          state,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      );
      await this.store.write(tokens);
    });
  }

  private async requestToken(body: URLSearchParams, previousRefresh?: string): Promise<Tokens> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(`${API_ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      text = await boundedText(response);
    } catch {
      throw new BankingError(
        'AUTH_UNAVAILABLE',
        'Token exchange failed. No automatic retry was attempted. Run login again if a refresh token was consumed.',
      );
    }
    if (!response.ok)
      throw new BankingError(
        'AUTH_REQUIRED',
        'Token exchange rejected. Check client credentials, redirect URI, and authorization expiry; run login again.',
        response.status,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BankingError('AUTH_INVALID_RESPONSE', 'Token endpoint returned invalid JSON.');
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success)
      throw new BankingError(
        'AUTH_INVALID_RESPONSE',
        'Token endpoint returned an unexpected token response.',
      );
    const t = parsed.data;
    const refresh = t.refresh_token ?? previousRefresh;
    return {
      accessToken: t.access_token,
      ...(refresh ? { refreshToken: refresh } : {}),
      expiresAt: Date.now() + t.expires_in * 1000,
      clientId: this.config.clientId!,
    };
  }
}
