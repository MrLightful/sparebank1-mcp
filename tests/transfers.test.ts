import { describe, expect, it } from 'vitest';
import { Transfers } from '../src/transfers.js';
import { json, ownedAccounts, setup } from './helpers.js';
import type { TransferInput } from '../src/schemas.js';

const transfer = {
  kind: 'account',
  fromAccount: '11111111111',
  toAccount: '22222222222',
  amount: '123.45',
} as const;
function transfers(extra: NodeJS.ProcessEnv = {}) {
  const s = setup({ SB1_ENABLE_TRANSFERS: 'true', ...extra });
  s.fetcher.mockResolvedValue(json({ accounts: ownedAccounts }));
  return { ...s, transfers: new Transfers(s.config, s.bank) };
}

describe('own-account transfer safeguards', () => {
  it('makes no request when transfers are disabled', async () => {
    const s = setup();
    await expect(new Transfers(s.config, s.bank).preview(transfer)).rejects.toMatchObject({
      code: 'TRANSFERS_DISABLED',
    });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('previews without submitting, normalizes decimals exactly, and keeps an immutable snapshot', async () => {
    const s = transfers();
    const preview = await s.transfers.preview({ ...transfer, amount: '0.1' });
    expect(preview.transfer.amount).toBe('0.10');
    preview.transfer.amount = '9999.00';
    expect(s.transfers.getPreview(preview.previewId).transfer.amount).toBe('0.10');
    expect(s.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it.each(['0', '-1', 'NaN', '1e3', '1.234', '01.00', '0.001'])(
    'rejects invalid amount %s without a bank call',
    async (amount) => {
      const s = transfers();
      await expect(s.transfers.preview({ ...transfer, amount })).rejects.toThrow();
      expect(s.fetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects configured limits with integer minor-unit comparison', async () => {
    const s = transfers({ SB1_MAX_TRANSFER_AMOUNT: '123.44' });
    await expect(s.transfers.preview(transfer)).rejects.toMatchObject({ code: 'TRANSFER_LIMIT' });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('rejects the same source and destination', async () => {
    const s = transfers();
    await expect(
      s.transfers.preview({ ...transfer, toAccount: transfer.fromAccount }),
    ).rejects.toMatchObject({ code: 'SAME_ACCOUNT' });
  });
  it('rejects non-owned destinations even when accessible', async () => {
    const s = transfers();
    const accounts = structuredClone(ownedAccounts);
    accounts[1]!.accountProperties.isOwned = false;
    s.fetcher.mockResolvedValue(json({ accounts }));
    await expect(s.transfers.preview(transfer)).rejects.toMatchObject({
      code: 'INVALID_DESTINATION_ACCOUNT',
    });
  });
  it('rejects blocked sources and disabled source transfers', async () => {
    const s = transfers();
    const accounts = structuredClone(ownedAccounts);
    accounts[0]!.accountProperties.isTransferFromEnabled = false;
    s.fetcher.mockResolvedValue(json({ accounts }));
    await expect(s.transfers.preview(transfer)).rejects.toMatchObject({
      code: 'INVALID_SOURCE_ACCOUNT',
    });
  });
  it('rejects an explicit currency different from the source account', async () => {
    const s = transfers();
    await expect(s.transfers.preview({ ...transfer, currencyCode: 'USD' })).rejects.toMatchObject({
      code: 'INVALID_CURRENCY',
    });
  });
  it('does not accept a credit card key in place of its account ID', async () => {
    const s = transfers();
    await expect(
      s.transfers.preview({
        kind: 'credit_card',
        fromAccount: transfer.fromAccount,
        amount: '100',
        creditCardAccountId: 'card-key',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DESTINATION_ACCOUNT' });
  });
  it.each([
    { input: transfer, endpoint: '/debit', target: { toAccount: '22222222222' } },
    {
      input: {
        kind: 'credit_card',
        fromAccount: transfer.fromAccount,
        amount: '123.45',
        creditCardAccountId: 'card-account-id',
      },
      endpoint: '/creditcard/transferTo',
      target: { creditCardAccountId: 'card-account-id' },
    },
    {
      input: {
        kind: 'pension',
        fromAccount: transfer.fromAccount,
        amount: '123.45',
        policyNumber: 'policy-9876',
      },
      endpoint: '/pension',
      target: { policyNumber: 'policy-9876' },
    },
  ])(
    'submits the exact approved request for $endpoint and preserves bank warnings',
    async ({ input, endpoint, target }) => {
      const s = transfers();
      const preview = await s.transfers.preview(input as TransferInput);
      s.fetcher
        .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
        .mockResolvedValueOnce(
          json({ paymentId: 'receipt', warnings: ['DUPLICATE_PAYMENT_EXISTS'] }),
        );
      const result = await s.transfers.confirm(preview.previewId, async (p) => {
        expect(p.transfer.amount).toBe('123.45');
        return true;
      });
      expect(result).toMatchObject({
        paymentId: 'receipt',
        warnings: ['DUPLICATE_PAYMENT_EXISTS'],
        submitted: true,
      });
      const [url, init] = s.fetcher.mock.calls[2]!;
      expect(String(url).endsWith(`/personal/banking/transfer${endpoint}`)).toBe(true);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        ...target,
        fromAccount: transfer.fromAccount,
        amount: '123.45',
      });
      expect(body).not.toHaveProperty('kind');
      expect(body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );
  it('does not submit after user decline, and invalidates the preview', async () => {
    const s = transfers();
    const p = await s.transfers.preview(transfer);
    await expect(s.transfers.confirm(p.previewId, async () => false)).rejects.toMatchObject({
      code: 'TRANSFER_DECLINED',
    });
    await expect(s.transfers.confirm(p.previewId, async () => true)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('prevents concurrent duplicate submissions while approval is pending', async () => {
    const s = transfers();
    const p = await s.transfers.preview(transfer);
    let approve!: (value: boolean) => void;
    const first = s.transfers.confirm(
      p.previewId,
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    await expect(s.transfers.confirm(p.previewId, async () => true)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
    approve(false);
    await expect(first).rejects.toMatchObject({ code: 'TRANSFER_DECLINED' });
  });
  it('expires previews before requesting approval', async () => {
    const s = transfers();
    let now = Date.now();
    const service = new Transfers(s.config, s.bank, () => now);
    const p = await service.preview(transfer);
    now += 5 * 60000;
    await expect(
      service.confirm(p.previewId, async () => {
        throw new Error('should not ask');
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
  });
  it('rechecks transfer permissions after approval and before submission', async () => {
    const s = transfers();
    const p = await s.transfers.preview(transfer);
    const accounts = structuredClone(ownedAccounts);
    accounts[0]!.accountProperties.isBlocked = true;
    s.fetcher.mockResolvedValue(json({ accounts }));
    await expect(s.transfers.confirm(p.previewId, async () => true)).rejects.toMatchObject({
      code: 'INVALID_SOURCE_ACCOUNT',
    });
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([401, 429, 500])('does not replay transfer POST after HTTP %s', async (status) => {
    const s = transfers();
    const p = await s.transfers.preview(transfer);
    s.fetcher
      .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
      .mockResolvedValueOnce(json({}, status));
    await expect(s.transfers.confirm(p.previewId, async () => true)).rejects.toMatchObject({
      status,
      outcomeUnknown: status >= 500,
    });
    expect(s.fetcher).toHaveBeenCalledTimes(3);
    await expect(s.transfers.confirm(p.previewId, async () => true)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
  });
  it('reports unknown outcomes after network failure and missing payment receipts', async () => {
    const s = transfers();
    const p = await s.transfers.preview(transfer);
    s.fetcher
      .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
      .mockRejectedValueOnce(new Error('network timeout'));
    await expect(s.transfers.confirm(p.previewId, async () => true)).rejects.toMatchObject({
      code: 'TRANSFER_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
    });
    expect(s.fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('transfer response and cancellation boundaries', () => {
  it.each([{}, { paymentId: 'receipt' }, { paymentId: 123, warnings: [] }])(
    'treats an incomplete receipt as an unknown outcome',
    async (receipt) => {
      const s = transfers();
      const p = await s.transfers.preview(transfer);
      s.fetcher
        .mockResolvedValueOnce(json({ accounts: ownedAccounts }))
        .mockResolvedValueOnce(json(receipt));
      await expect(s.transfers.confirm(p.previewId, async () => true)).rejects.toMatchObject({
        code: 'TRANSFER_OUTCOME_UNKNOWN',
        outcomeUnknown: true,
      });
      expect(s.fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it('expires a preview while the user is deciding', async () => {
    const s = transfers();
    let now = Date.now();
    const service = new Transfers(s.config, s.bank, () => now);
    const p = await service.preview(transfer);
    await expect(
      service.confirm(p.previewId, async () => {
        now += 5 * 60000;
        return true;
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('blocks cancellation between account revalidation and submission', async () => {
    const { operation } = await import('../src/operation.js');
    const s = transfers();
    const p = await s.transfers.preview(transfer);
    const controller = new AbortController();
    s.fetcher.mockImplementationOnce(async () => {
      controller.abort();
      return json({ accounts: ownedAccounts });
    });
    await expect(
      operation.run({ signal: controller.signal }, () =>
        s.transfers.confirm(p.previewId, async () => true),
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED', outcomeUnknown: false });
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it('enforces the pension endpoint maximum even if the local limit is larger', async () => {
    const s = transfers({ SB1_MAX_TRANSFER_AMOUNT: '9999999999.99' });
    await expect(
      s.transfers.preview({
        kind: 'pension',
        fromAccount: transfer.fromAccount,
        amount: '2000000.01',
        policyNumber: 'policy-9876',
      }),
    ).rejects.toMatchObject({ code: 'TRANSFER_LIMIT' });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
});

describe('fresh account validation', () => {
  it('checks expiry again after the account lookup completes', async () => {
    const s = transfers();
    let now = Date.now();
    const service = new Transfers(s.config, s.bank, () => now);
    const preview = await service.preview(transfer);
    s.fetcher.mockImplementationOnce(async () => {
      now += 5 * 60000;
      return json({ accounts: ownedAccounts });
    });
    await expect(service.confirm(preview.previewId, async () => true)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it('fails closed when the bank does not report blocked-account status', async () => {
    const s = transfers();
    const account = {
      ...ownedAccounts[0],
      accountProperties: { isOwned: true, isTransferFromEnabled: true },
    };
    s.fetcher.mockResolvedValue(json({ accounts: [account, ownedAccounts[1]] }));
    await expect(s.transfers.preview(transfer)).rejects.toMatchObject({
      code: 'INVALID_SOURCE_ACCOUNT',
    });
  });
});
