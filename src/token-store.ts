import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';
import { BankingError } from './errors.js';

const tokenSchema = z.object({
  accessToken: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().positive(),
  clientId: z.string().min(1),
});
export type Tokens = z.infer<typeof tokenSchema>;

export class TokenStore {
  constructor(readonly path: string) {}

  async read(): Promise<Tokens | undefined> {
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new BankingError(
          'TOKEN_FILE_PERMISSIONS',
          'Token file must be a regular file with mode 0600.',
        );
      }
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await file.stat()).size > 65536) throw new Error('too large');
        return tokenSchema.parse(JSON.parse(await file.readFile('utf8')));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof BankingError) throw error;
      throw new BankingError(
        'TOKEN_FILE_INVALID',
        'Cannot read token file. Run login again or check its permissions.',
      );
    }
  }

  async write(tokens: Tokens): Promise<void> {
    const validated = tokenSchema.parse(tokens);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(tmp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(validated));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  async clear(): Promise<void> {
    await unlink(this.path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + 20000;
    let lock;
    for (;;) {
      try {
        lock = await open(lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline)
          throw new BankingError(
            'TOKEN_STORE_BUSY',
            'Token store is locked. If a previous process crashed, remove its .lock file after stopping all server instances.',
          );
        await delay(50);
      }
    }
    try {
      await lock.writeFile(String(process.pid));
      return await work();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
