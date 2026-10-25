import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startLogin() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No callback port');
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), 'sb1-login-test-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('SB1_')),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'login'], {
    env: {
      ...env,
      SB1_CLIENT_ID: 'test-client',
      SB1_CLIENT_SECRET: 'synthetic-secret',
      SB1_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
      SB1_TOKEN_FILE: join(dir, 'tokens.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
  await vi.waitFor(() => expect(stderr).toContain('Waiting for the registered local callback'), {
    timeout: 3000,
  });
  const authorization = new URL(
    stderr.match(/https:\/\/api\.sparebank1\.no\/oauth\/authorize[^\s]+/)![0],
  );
  return {
    port,
    child,
    exited,
    stderr: () => stderr,
    callback: `http://127.0.0.1:${port}/callback`,
    state: authorization.searchParams.get('state')!,
  };
}

describe('local login callback lifecycle', () => {
  it('rejects malformed HTTP request targets without crashing the login process', async () => {
    const login = await startLogin();
    let response = '';
    await new Promise<void>((resolve) => {
      const socket = createConnection(login.port, '127.0.0.1', () => {
        socket.write(
          `GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${login.port}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on('data', (data) => {
        response += String(data);
      });
      socket.on('error', () => {});
      socket.once('close', () => resolve());
    });
    expect(response).toContain('400');
    expect(login.stderr()).not.toContain('ERR_INVALID_URL');
    expect(login.child.exitCode).toBeNull();
    const invalidState = await fetch(`${login.callback}?error=access_denied&state=wrong`);
    expect(invalidState.status).toBe(400);
  });

  it('finishes promptly when the bank returns an authorization denial with matching state', async () => {
    const login = await startLogin();
    const response = await fetch(`${login.callback}?error=access_denied&state=${login.state}`);
    expect(response.status).toBe(400);
    const code = await Promise.race([login.exited, delay(750).then(() => 'timeout')]);
    expect(code).toBe(1);
    expect(login.stderr()).toContain('Bank authorization was declined or failed.');
    expect(login.stderr()).not.toContain('Login saved');
  });
});
