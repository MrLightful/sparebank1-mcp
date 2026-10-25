import { describe, expect, it } from 'vitest';
import { setup, json } from './helpers.js';
import { transactionOptions } from '../src/schemas.js';
import { readFileSync, readdirSync } from 'node:fs';

describe('bank API wire contract', () => {
  it('uses the account v5 endpoint once, with explicit false filters', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(json({ accounts: [] }));
    await bank.listAccounts({ includeNokAccounts: false, includeCreditCardAccounts: true });
    const [raw, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(raw));
    expect(url.origin + url.pathname).toBe('https://api.sparebank1.no/personal/banking/accounts');
    expect(url.searchParams.get('includeNokAccounts')).toBe('false');
    expect(init?.headers).toMatchObject({
      Accept: 'application/vnd.sparebank1.v5+json; charset=utf-8',
      Authorization: 'Bearer test-access-secret',
    });
    expect(init?.redirect).toBe('error');
  });
  it('encodes account keys as a single path component', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(json({ key: 'key/with+base64=' }));
    await bank.getAccount('key/with+base64=', true);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/accounts/key%2Fwith%2Bbase64%3D/details');
  });
  it('serializes repeated query parameters instead of comma-joining', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(json({ accountKeysMap: {} }));
    await bank.getAccountKeys(['11111111111', '22222222222']);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.getAll('accountNumber')).toEqual(
      ['11111111111', '22222222222'],
    );
  });
  it('implements balance as a read-only versioned POST', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(json({ accountBalance: 50 }));
    expect(await bank.getBalance('11111111111')).toEqual({ accountBalance: 50 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url).endsWith('/accounts/balance')).toBe(true);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ accountNumber: '11111111111' });
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/vnd.sparebank1.v5+json; charset=utf-8',
    });
  });
  it.each([false, true])(
    'honors published parameter names for classified=%s and preserves partial errors',
    async (classified) => {
      const { fetcher, bank } = setup();
      fetcher.mockResolvedValue(
        json({ transactions: [{ id: 'a' }], errors: ['HISTORIC_TRANSACTIONS_FAILED'] }),
      );
      const result = (await bank.listTransactions(
        transactionOptions.parse({
          accountKeys: ['a', 'b'],
          rowLimit: 1,
          source: 'ALL',
          classified,
        }),
      )) as Record<string, unknown>;
      const [url, init] = fetcher.mock.calls[0]!;
      expect(
        new URL(String(url)).searchParams.getAll(classified ? 'Account keys' : 'accountKey'),
      ).toEqual(['a', 'b']);
      expect(new URL(String(url)).searchParams.get('Transaction source')).toBe('ALL');
      expect(init?.headers).toMatchObject({
        Accept: 'application/vnd.sparebank1.v1+json; charset=utf-8',
      });
      expect(result.errors).toEqual(['HISTORIC_TRANSACTIONS_FAILED']);
      expect(result.coverage).toMatchObject({ possiblyTruncated: true, partialFailure: true });
    },
  );
  it('returns CSV without trying to parse it as JSON', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(new Response('Dato;Beskrivelse\n2026-10-01;Øre'));
    expect(await bank.exportTransactions('key', '2026-10-01', '2026-10-25')).toEqual({
      csv: 'Dato;Beskrivelse\n2026-10-01;Øre',
    });
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      Accept: 'application/csv;charset=UTF-8',
    });
  });
  it('reports malformed transaction payloads', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(json({ unexpected: true }));
    await expect(
      bank.listTransactions(transactionOptions.parse({ accountKeys: ['a'] })),
    ).rejects.toMatchObject({ code: 'BANK_INVALID_RESPONSE' });
  });
  it('never returns raw upstream errors or bearer tokens', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(
      json({ errors: [{ code: 'account.no.access', message: 'secret test-access-secret' }] }, 403),
    );
    await expect(bank.listAccounts()).rejects.toMatchObject({
      message: expect.not.stringContaining('test-access-secret'),
      bankCodes: ['account.no.access'],
    });
  });
  it('reports rate limits without sleeping or replaying', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(json({}, 429, { 'retry-after': '15' }));
    await expect(bank.listAccounts()).rejects.toMatchObject({ status: 429, retryAfterSeconds: 15 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects redirects and never forwards credentials elsewhere', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockRejectedValue(new TypeError('redirect'));
    await expect(bank.listAccounts()).rejects.toMatchObject({ code: 'BANK_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
  });
  it('bounds response bodies', async () => {
    const { fetcher, bank } = setup();
    fetcher.mockResolvedValue(new Response('a'.repeat(4 * 1024 * 1024 + 1)));
    await expect(bank.listAccounts()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('does not invent an endpoint or query name absent from frozen bank schemas', async () => {
    const operations = readdirSync('docs/openapi').flatMap((file) => {
      const spec = JSON.parse(readFileSync(`docs/openapi/${file}`, 'utf8')) as {
        paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
      };
      return Object.entries(spec.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, op]) => ({
          path,
          method,
          parameters: op.parameters?.map((p) => p.name) ?? [],
        })),
      );
    });
    const cases = [
      {
        action: (b: ReturnType<typeof setup>['bank']) => b.listAccounts(),
        path: '/accounts',
        method: 'get',
      },
      {
        action: (b: ReturnType<typeof setup>['bank']) => b.getAccount('key'),
        path: '/accounts/{accountKey}',
        method: 'get',
      },
      {
        action: (b: ReturnType<typeof setup>['bank']) => b.getAccount('key', true),
        path: '/accounts/{accountKey}/details',
        method: 'get',
      },
      {
        action: (b: ReturnType<typeof setup>['bank']) => b.getAccountKeys(['11111111111']),
        path: '/accounts/keys',
        method: 'get',
      },
      {
        action: (b: ReturnType<typeof setup>['bank']) => b.getBalance('11111111111'),
        path: '/accounts/balance',
        method: 'post',
      },
      {
        action: (b: ReturnType<typeof setup>['bank']) => b.getChildAccounts('child'),
        path: '/accounts/child/{id}',
        method: 'get',
      },
      ...[false, true].flatMap((classified) => [
        {
          action: (b: ReturnType<typeof setup>['bank']) =>
            b.listTransactions(
              transactionOptions.parse({ accountKeys: ['key'], classified, source: 'ALL' }),
            ),
          path: `/transactions${classified ? '/classified' : ''}`,
          method: 'get',
        },
        {
          action: (b: ReturnType<typeof setup>['bank']) =>
            b.transactionDetails('id', classified, true),
          path: `/transactions/{id}/details${classified ? '/classified' : ''}`,
          method: 'get',
        },
      ]),
      {
        action: (b: ReturnType<typeof setup>['bank']) =>
          b.exportTransactions('key', '2026-10-01', '2026-10-02', 'DATE'),
        path: '/transactions/export',
        method: 'get',
      },
    ];
    for (const testCase of cases) {
      const { bank, fetcher } = setup();
      fetcher.mockResolvedValue(json({ transactions: [] }));
      await testCase.action(bank);
      const [raw, init] = fetcher.mock.calls[0]!;
      const url = new URL(String(raw));
      const op = operations.find((o) => o.path === testCase.path && o.method === testCase.method)!;
      expect(op).toBeDefined();
      const actualPath = url.pathname.replace('/personal/banking', '');
      const pattern = new RegExp(`^${op.path.replace(/\{[^}]+\}/g, '[^/]+')}$`);
      expect(actualPath).toMatch(pattern);
      expect((init?.method ?? 'GET').toLowerCase()).toBe(op.method);
      for (const name of url.searchParams.keys()) expect(op.parameters).toContain(name);
    }
  });
});

describe('MCP operation cancellation', () => {
  it('does not send a bank request after cancellation', async () => {
    const { operation } = await import('../src/operation.js');
    const { bank, fetcher } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      operation.run({ signal: controller.signal }, () => bank.listAccounts()),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
