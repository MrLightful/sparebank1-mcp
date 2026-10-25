#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Auth } from './auth.js';
import { readConfig, VERSION } from './config.js';
import { login } from './login.js';
import { createServer } from './server.js';
import { BankingError } from './errors.js';

const HELP = `sparebank1-mcp ${VERSION}

Usage:
  sparebank1-mcp                 Serve MCP over stdio
  sparebank1-mcp login           Authorize using BankID and a loopback callback
  sparebank1-mcp login --manual  Paste the registered redirect URL in your terminal
  sparebank1-mcp status          Inspect local authentication (no bank call)
  sparebank1-mcp logout          Delete locally saved tokens
  sparebank1-mcp --help
  sparebank1-mcp --version

Configuration is read from environment variables. With a local .env file:
  node --env-file=/absolute/path/.env /absolute/path/dist/index.js login
See README.md and .env.example. Never paste credentials into chat.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args[0] ?? 'serve';
  if (
    !['serve', 'login', 'status', 'logout'].includes(command) ||
    (command === 'login'
      ? args.length > 2 || (args.length === 2 && args[1] !== '--manual')
      : args.length > 1)
  )
    throw new Error('Unknown command or argument. Run sparebank1-mcp --help.');
  const config = readConfig();
  const auth = new Auth(config);
  if (command === 'login') {
    await login(config, args[1] === '--manual');
    return;
  }
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(await auth.status(), null, 2)}\n`);
    return;
  }
  if (command === 'logout') {
    await auth.store.locked(() => auth.store.clear());
    process.stderr.write(
      'Local tokens removed. Stop running server instances. To revoke bank authorization, delete the customer client in the developer portal. Environment access tokens are unaffected.\n',
    );
    return;
  }
  const handle = serveStdio((ctx) => createServer(config, { era: ctx.era }), {
    onerror: () => process.stderr.write('MCP transport error.\n'),
  });
  const shutdown = () => {
    void handle.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  // Only locally constructed messages; never print raw network error objects.
  const message =
    error instanceof BankingError ||
    (error instanceof Error &&
      /^(Invalid configuration|SB1_|Set SB1_|Unset SB1_|Automatic callback|Manual login|Unknown command)/.test(
        error.message,
      ))
      ? error.message
      : 'Operation failed. Check local configuration; see README.md.';
  process.stderr.write(`sparebank1-mcp: ${message}\n`);
  process.exitCode = 1;
});
