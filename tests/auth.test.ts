import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { BankClient } from '../src/bank-client.js';
import { authorizationUrl, validateCallback } from '../src/login.js';
import { readConfig } from '../src/config.js';
import { json } from './helpers.js';
import type { Fetch } from '../src/http.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function managed() {
  const dir = await mkdtemp(join(tmpdir(), 'sb1-test-'));
  dirs.push(dir);
  const config = readConfig({
    SB1_CLIENT_ID: 'client',
    SB1_CLIENT_SECRET: 'client-secret',
    SB1_REDIRECT_URI: 'http://127.0.0.1:8765/callback',
    SB1_TOKEN_FILE: join(dir, 'tokens.json'),
  });
  const fetcher = vi.fn<Fetch>();
  const auth = new Auth(config, fetcher);
  await auth.store.write({
    clientId: 'client',
    accessToken: 'old',
    refreshToken: 'refresh',
    expiresAt: Date.now() - 1000,
  });
  return { config, fetcher, auth };
}

describe('managed OAuth', () => {
  it('refreshes once across concurrent requests and persists token rotation with restrictive permissions', async () => {
    const { auth, fetcher } = await managed();
    fetcher.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return json({
        access_token: 'new',
        refresh_token: 'rotated',
        token_type: 'Bearer',
        expires_in: 600,
      });
    });
    expect(await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()])).toEqual(
      ['new', 'new', 'new'],
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0]!;
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect((init?.body as URLSearchParams).get('refresh_token')).toBe('refresh');
    expect(await auth.store.read()).toMatchObject({ refreshToken: 'rotated', accessToken: 'new' });
    expect((await lstat(auth.store.path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await auth.status())).not.toContain('rotated');
  });
  it('coordinates rotation across independent Auth instances sharing a file', async () => {
    const { config, auth, fetcher } = await managed();
    const other = new Auth(config, fetcher);
    fetcher.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return json({
        access_token: 'new',
        refresh_token: 'rotated',
        token_type: 'Bearer',
        expires_in: 600,
      });
    });
    expect(await Promise.all([auth.accessToken(), other.accessToken()])).toEqual(['new', 'new']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains the existing refresh token if the server does not rotate it', async () => {
    const { auth, fetcher } = await managed();
    fetcher.mockResolvedValue(json({ access_token: 'new', token_type: 'Bearer', expires_in: 600 }));
    await auth.accessToken();
    expect((await auth.store.read())?.refreshToken).toBe('refresh');
  });
  it('does not guess token lifetimes or accept malformed OAuth payloads', async () => {
    const { auth, fetcher } = await managed();
    fetcher.mockResolvedValue(json({ access_token: 'new', token_type: 'Bearer' }));
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'AUTH_INVALID_RESPONSE' });
    expect((await auth.store.read())?.accessToken).toBe('old');
  });
  it('preserves saved tokens and never leaks rejected OAuth response bodies', async () => {
    const { auth, fetcher } = await managed();
    const before = await readFile(auth.store.path, 'utf8');
    fetcher.mockResolvedValue(json({ error_description: 'client-secret refresh' }, 400));
    await expect(auth.accessToken()).rejects.toMatchObject({
      message: expect.not.stringContaining('client-secret'),
    });
    expect(await readFile(auth.store.path, 'utf8')).toBe(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refreshes a rejected but unexpired token once for a read', async () => {
    const { auth, fetcher, config } = await managed();
    await auth.store.write({
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 600000,
      clientId: 'client',
    });
    fetcher
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: 'new', token_type: 'Bearer', expires_in: 600 }))
      .mockResolvedValueOnce(json({ accounts: [] }));
    expect(
      await new BankClient(config, auth, fetcher).request({
        path: '/personal/banking/accounts',
        version: 5,
      }),
    ).toEqual({ accounts: [] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]![1]?.headers).toMatchObject({ Authorization: 'Bearer new' });
  });
  it('rejects another OAuth client’s saved tokens', async () => {
    const { auth, fetcher } = await managed();
    await auth.store.write({ accessToken: 'x', clientId: 'other', expiresAt: Date.now() + 600000 });
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'TOKEN_CLIENT_MISMATCH' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed on overly permissive token files', async () => {
    const { auth } = await managed();
    await chmod(auth.store.path, 0o644);
    await expect(auth.store.read()).rejects.toMatchObject({ code: 'TOKEN_FILE_PERMISSIONS' });
  });
  it('returns an actionable error when no login exists', async () => {
    const { auth } = await managed();
    await auth.store.clear();
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('writes authorization-code exchanges using the exact registered callback and state', async () => {
    const { auth, fetcher } = await managed();
    fetcher.mockResolvedValue(
      json({
        access_token: 'new',
        refresh_token: 'rotated',
        token_type: 'bearer',
        expires_in: 600,
      }),
    );
    await auth.exchangeCode('code+a/b', '123456');
    const body = fetcher.mock.calls[0]![1]?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'code+a/b',
      state: '123456',
      client_id: 'client',
      client_secret: 'client-secret',
      redirect_uri: 'http://127.0.0.1:8765/callback',
    });
  });
});

describe('OAuth callback protection', () => {
  const uri = 'http://127.0.0.1:8765/callback';
  it('builds a bank authorization URL without the client secret', () => {
    const config = readConfig({
      SB1_CLIENT_ID: 'client',
      SB1_CLIENT_SECRET: 'never-in-url',
      SB1_REDIRECT_URI: uri,
      SB1_FIN_INST: 'fid',
    });
    const url = authorizationUrl(config, '12345');
    expect(url.searchParams.get('finInst')).toBe('fid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.href).not.toContain('never-in-url');
  });
  it('accepts only one code and an exact state', () => {
    expect(validateCallback(`${uri}?code=abc&state=123`, uri, '123')).toBe('abc');
  });
  it.each([
    `${uri}?code=abc&state=wrong`,
    `${uri}?code=abc`,
    `${uri}?code=abc&state=123&state=123`,
    `${uri}?code=abc&code=def&state=123`,
    `${uri}?error=denied&state=123`,
    `http://evil.test/callback?code=abc&state=123`,
    `${uri}/other?code=abc&state=123`,
    `${uri}?code=abc&state=123#fragment`,
  ])('rejects invalid callback %s', (callback) => {
    expect(() => validateCallback(callback, uri, '123')).toThrow();
  });
});
