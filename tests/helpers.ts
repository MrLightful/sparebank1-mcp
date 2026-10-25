import { vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { Auth } from '../src/auth.js';
import { BankClient } from '../src/bank-client.js';
import { Banking } from '../src/banking.js';
import type { Fetch } from '../src/http.js';

export const config = (extra: NodeJS.ProcessEnv = {}) =>
  readConfig({ SB1_ACCESS_TOKEN: 'test-access-secret', ...extra });
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
export function setup(extra: NodeJS.ProcessEnv = {}) {
  const c = config(extra);
  const fetcher = vi.fn<Fetch>();
  const auth = new Auth(c, fetcher);
  const client = new BankClient(c, auth, fetcher);
  const bank = new Banking(client);
  return { config: c, fetcher, auth, client, bank };
}
export const ownedAccounts = [
  {
    accountNumber: '11111111111',
    key: 'key-from',
    type: 'USER',
    currencyCode: 'NOK',
    accountProperties: {
      isOwned: true,
      isBlocked: false,
      isTransferFromEnabled: true,
      isTransferToEnabled: true,
    },
  },
  {
    accountNumber: '22222222222',
    key: 'key-to',
    type: 'SAVING',
    currencyCode: 'NOK',
    accountProperties: {
      isOwned: true,
      isBlocked: false,
      isTransferFromEnabled: true,
      isTransferToEnabled: true,
    },
  },
  {
    accountNumber: 'K1234',
    key: 'card-key',
    creditCardAccountID: 'card-account-id',
    type: 'CREDITCARD',
    currencyCode: 'NOK',
    accountProperties: { isOwned: true, isBlocked: false },
  },
  {
    accountNumber: 'P9876',
    key: 'policy-9876',
    type: 'PENSION',
    currencyCode: 'NOK',
    accountProperties: { isOwned: true, isBlocked: false },
  },
];
