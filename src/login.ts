import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import type { Config } from './config.js';
import { API_ORIGIN, requireOAuth, validateRedirect } from './config.js';
import { Auth } from './auth.js';
import { BankingError } from './errors.js';

export function authorizationUrl(config: Config, state: string): URL {
  const { clientId, redirectUri } = requireOAuth(config);
  const url = new URL('/oauth/authorize', API_ORIGIN);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    ...(config.finInst ? { finInst: config.finInst } : {}),
  }).toString();
  return url;
}

export function validateCallback(raw: string, redirectUri: string, state: string): string {
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    throw new BankingError(
      'INVALID_CALLBACK',
      'Paste the complete redirect URL, including code and state.',
    );
  }
  const expected = new URL(redirectUri);
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    throw new BankingError(
      'INVALID_CALLBACK',
      'Callback URL does not match the registered redirect URI.',
    );
  const states = callback.searchParams.getAll('state');
  const actual = Buffer.from(states[0] ?? '');
  const wanted = Buffer.from(state);
  if (states.length !== 1 || actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
    throw new BankingError('INVALID_STATE', 'OAuth state did not match. No tokens were requested.');
  if (callback.searchParams.has('error'))
    throw new BankingError('AUTH_DENIED', 'Bank authorization was declined or failed.');
  const codes = callback.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0] || codes[0].length > 8192)
    throw new BankingError(
      'INVALID_CALLBACK',
      'Callback must contain exactly one authorization code.',
    );
  return codes[0];
}

export async function login(config: Config, manual = false): Promise<void> {
  if (config.accessToken)
    throw new Error(
      'Unset SB1_ACCESS_TOKEN before using managed login; it overrides saved credentials.',
    );
  const { redirectUri } = requireOAuth(config);
  const redirect = validateRedirect(redirectUri);
  // The bank documents state as a client-defined number. Generate 128 random bits
  // and encode as decimal to match that documented format without losing entropy.
  const state = BigInt(`0x${randomBytes(16).toString('hex')}`).toString();
  const url = authorizationUrl(config, state);
  const auth = new Auth(config);
  if (manual) {
    if (!stdin.isTTY) throw new Error('Manual login requires an interactive terminal.');
    stderr.write(`Open this URL in your browser and complete BankID:\n${url.href}\n`);
    const terminal = createInterface({ input: stdin, output: stderr });
    try {
      const callback = await terminal.question(
        'Paste the full redirect URL here (keep it out of chat): ',
      );
      await auth.exchangeCode(validateCallback(callback.trim(), redirectUri, state), state);
    } finally {
      terminal.close();
    }
  } else {
    if (
      redirect.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(redirect.hostname) ||
      !redirect.port
    ) {
      throw new Error(
        'Automatic callback requires http://127.0.0.1:PORT/callback (or localhost) registered in the portal. Use login --manual for HTTPS redirect URIs.',
      );
    }
    await new Promise<void>((resolve, reject) => {
      let busy = false;
      const server = httpServer(async (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        if (request.method !== 'GET' || request.headers.host !== redirect.host) {
          response.writeHead(400).end('Invalid callback request.');
          return;
        }
        let callback: URL;
        try {
          callback = new URL(request.url ?? '/', redirect.origin);
        } catch {
          response.writeHead(400).end('Invalid callback URL.');
          return;
        }
        if (callback.pathname !== redirect.pathname) {
          response.writeHead(404).end('Not found.');
          return;
        }
        let code: string;
        try {
          code = validateCallback(callback.href, redirectUri, state);
        } catch (error) {
          if (error instanceof BankingError && error.code === 'AUTH_DENIED') {
            response.once('finish', () => finish(error));
            response.writeHead(400).end('Bank authorization was declined or failed.');
          } else {
            response
              .writeHead(400)
              .end('Invalid authorization response. Retry login in the terminal.');
          }
          return;
        }
        if (busy) {
          response.writeHead(409).end('Authorization is already being processed.');
          return;
        }
        busy = true;
        try {
          await auth.exchangeCode(code, state);
          response.once('finish', () => finish());
          response.end('SpareBank 1 login complete. You may close this window.');
        } catch {
          response.once('finish', () =>
            finish(
              new BankingError(
                'AUTH_FAILED',
                'Token exchange failed; check configuration and run login again.',
              ),
            ),
          );
          response.writeHead(502).end('Token exchange failed. Return to the terminal.');
        }
      });
      const timer = setTimeout(
        () =>
          finish(
            new BankingError(
              'LOGIN_TIMEOUT',
              'Login timed out after five minutes. Run login again.',
            ),
          ),
        5 * 60000,
      );
      const abort = () => finish(new BankingError('LOGIN_CANCELLED', 'Login cancelled.'));
      function finish(error?: Error) {
        clearTimeout(timer);
        process.removeListener('SIGINT', abort);
        server.closeAllConnections();
        server.close();
        if (error) reject(error);
        else resolve();
      }
      process.once('SIGINT', abort);
      server.once('error', () =>
        finish(
          new BankingError(
            'CALLBACK_LISTEN_FAILED',
            'Cannot bind the callback port. Stop the other listener or configure another registered port.',
          ),
        ),
      );
      server.listen(
        Number(redirect.port),
        redirect.hostname === 'localhost' ? 'localhost' : '127.0.0.1',
        () => {
          stderr.write(
            `Open this URL in your browser and complete BankID:\n${url.href}\nWaiting for the registered local callback…\n`,
          );
        },
      );
    });
  }
  stderr.write(
    'Login saved locally with mode 0600. Restart your MCP client if it is already running.\n',
  );
}
