import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { toMinor } from './config.js';
import { Banking, BANKING } from './banking.js';
import { BankingError } from './errors.js';
import { osloToday, transferInput } from './schemas.js';
import type { TransferInput } from './schemas.js';

interface Account {
  accountNumber?: string;
  key?: string;
  type?: string;
  currencyCode?: string;
  creditCardAccountID?: string;
  accountProperties?: {
    isOwned?: boolean;
    isBlocked?: boolean;
    isTransferFromEnabled?: boolean;
    isTransferToEnabled?: boolean;
  };
}
export interface Preview {
  previewId: string;
  expiresAt: string;
  transfer: TransferInput & { dueDate: string };
  currencyCode: string;
  notice: string;
}
export type Confirm = (preview: Preview) => Promise<boolean>;

export class Transfers {
  private readonly previews = new Map<string, Preview>();
  constructor(
    private readonly config: Config,
    private readonly banking: Banking,
    private readonly now: () => number = Date.now,
  ) {}

  async preview(input: TransferInput): Promise<Preview> {
    this.enabled();
    const parsed = transferInput.parse(input);
    const today = osloToday(new Date(this.now()));
    const dueDate = parsed.dueDate ?? today;
    if (dueDate < today)
      throw new BankingError('INVALID_DUE_DATE', 'Due date cannot be in the past in Europe/Oslo.');
    const minor = toMinor(parsed.amount);
    const apiMax =
      parsed.kind === 'pension'
        ? 200000000n
        : parsed.kind === 'credit_card'
          ? 99999999900n
          : 100000000000n;
    if (minor > this.config.maxTransferMinor || minor > apiMax)
      throw new BankingError(
        'TRANSFER_LIMIT',
        'Amount exceeds the configured per-transfer limit or bank endpoint maximum.',
      );
    const transfer = {
      ...parsed,
      amount: `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`,
      dueDate,
    };
    const currencyCode = await this.validateAccounts(transfer);
    this.prune();
    if (this.previews.size >= 50)
      throw new BankingError(
        'TOO_MANY_PREVIEWS',
        'Too many outstanding transfer previews. Wait for old previews to expire.',
      );
    const result: Preview = {
      previewId: randomBytes(24).toString('hex'),
      expiresAt: new Date(this.now() + 5 * 60000).toISOString(),
      transfer,
      currencyCode,
      notice:
        'No transfer has been submitted. Confirming will move real money. Bank limits, fees, restrictions and date adjustments still apply. Credit-card balances may update next business day.',
    };
    this.previews.set(result.previewId, structuredClone(result));
    return result;
  }

  getPreview(previewId: string): Preview {
    const preview = this.previews.get(previewId);
    if (!preview || Date.parse(preview.expiresAt) <= this.now())
      throw new BankingError(
        'PREVIEW_EXPIRED',
        'Preview expired or was used. Create a new preview.',
      );
    return structuredClone(preview);
  }

  async confirm(previewId: string, confirm: Confirm): Promise<unknown> {
    this.enabled();
    const preview = this.previews.get(previewId);
    // Consume synchronously before any await to prevent concurrent duplicate calls.
    this.previews.delete(previewId);
    if (!preview || Date.parse(preview.expiresAt) <= this.now())
      throw new BankingError(
        'PREVIEW_EXPIRED',
        'Preview expired, was used, or belongs to another process. Create a new preview.',
      );
    if (!(await confirm(structuredClone(preview))))
      throw new BankingError(
        'TRANSFER_DECLINED',
        'Transfer was not approved. No transfer was submitted.',
      );
    this.ensureFresh(preview);
    const currency = await this.validateAccounts(preview.transfer);
    if (currency !== preview.currencyCode)
      throw new BankingError(
        'ACCOUNT_CHANGED',
        'Account currency changed since preview. Create a new preview.',
      );
    this.ensureFresh(preview);
    const { kind, ...body } = preview.transfer;
    const endpoint =
      kind === 'account' ? 'debit' : kind === 'credit_card' ? 'creditcard/transferTo' : 'pension';
    const result = await this.banking.client.request({
      path: `${BANKING}/transfer/${endpoint}`,
      version: 1,
      method: 'POST',
      body,
      mutation: true,
    });
    const data = result as Record<string, unknown>;
    if (typeof data.paymentId !== 'string' || !Array.isArray(data.warnings))
      throw new BankingError(
        'TRANSFER_OUTCOME_UNKNOWN',
        'Bank response did not contain the expected payment receipt.',
        undefined,
        undefined,
        true,
      );
    return {
      ...data,
      transfer: preview.transfer,
      currencyCode: currency,
      submitted: true,
      note: 'Submission is acknowledged. Check bank warnings and online banking for execution/settlement status.',
    };
  }

  private async validateAccounts(input: TransferInput): Promise<string> {
    const data = (await this.banking.listAccounts({
      includeCreditCardAccounts: true,
      includePensionAccounts: true,
      includeAskAccounts: true,
    })) as { accounts?: Account[] };
    if (!Array.isArray(data.accounts))
      throw new BankingError('BANK_INVALID_RESPONSE', 'Expected an accounts array.');
    const from = data.accounts.find((a) => a.accountNumber === input.fromAccount);
    if (
      !from ||
      from.accountProperties?.isOwned !== true ||
      from.accountProperties.isBlocked !== false ||
      from.accountProperties.isTransferFromEnabled !== true
    )
      throw new BankingError(
        'INVALID_SOURCE_ACCOUNT',
        'Source must be an owned, unblocked account enabled for transfers.',
      );
    if (!from.currencyCode || !/^[A-Z]{3}$/.test(from.currencyCode))
      throw new BankingError('INVALID_CURRENCY', 'Source account currency is unavailable.');
    const to = data.accounts.find((a) =>
      input.kind === 'account'
        ? a.accountNumber === input.toAccount && !['CREDITCARD', 'PENSION'].includes(a.type ?? '')
        : input.kind === 'credit_card'
          ? a.type === 'CREDITCARD' && a.creditCardAccountID === input.creditCardAccountId
          : a.type === 'PENSION' && a.key === input.policyNumber,
    );
    if (!to || to.accountProperties?.isOwned !== true || to.accountProperties.isBlocked !== false)
      throw new BankingError(
        'INVALID_DESTINATION_ACCOUNT',
        'Destination must be an owned, unblocked account returned by the bank. Use the correct credit-card account ID or pension policy number.',
      );
    if (input.kind === 'account') {
      if (input.fromAccount === input.toAccount)
        throw new BankingError('SAME_ACCOUNT', 'Source and destination must differ.');
      if (to.accountProperties.isTransferToEnabled !== true)
        throw new BankingError(
          'INVALID_DESTINATION_ACCOUNT',
          'Destination is not enabled for transfers.',
        );
      if (input.currencyCode && input.currencyCode !== from.currencyCode)
        throw new BankingError(
          'INVALID_CURRENCY',
          'Transfer currency must match the source account.',
        );
    } else if (from.currencyCode !== 'NOK' || to.currencyCode !== 'NOK') {
      throw new BankingError(
        'INVALID_CURRENCY',
        'Credit-card and pension transfers require NOK accounts.',
      );
    }
    return from.currencyCode;
  }
  private ensureFresh(preview: Preview): void {
    if (
      Date.parse(preview.expiresAt) <= this.now() ||
      preview.transfer.dueDate < osloToday(new Date(this.now()))
    ) {
      throw new BankingError(
        'PREVIEW_EXPIRED',
        'Preview expired during confirmation. Create a new preview.',
      );
    }
  }
  private enabled(): void {
    if (!this.config.enableTransfers)
      throw new BankingError(
        'TRANSFERS_DISABLED',
        'Transfers are disabled. Set SB1_ENABLE_TRANSFERS=true locally and restart to enable.',
      );
  }
  private prune(): void {
    for (const [id, p] of this.previews)
      if (Date.parse(p.expiresAt) <= this.now()) this.previews.delete(id);
  }
}
