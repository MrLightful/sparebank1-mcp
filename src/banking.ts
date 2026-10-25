import { BankClient } from './bank-client.js';
import type { Query } from './bank-client.js';
import type { TransactionOptions } from './schemas.js';
import { BankingError } from './errors.js';

export const BANKING = '/personal/banking';
export const EXPORT_FIELDS = [
  'DATE',
  'DESCRIPTION',
  'INTEREST_DATE',
  'IN',
  'OUT',
  'TO_ACCOUNT',
  'FROM_ACCOUNT',
  'CATEGORY',
  'SUBCATEGORY',
] as const;
export class Banking {
  constructor(readonly client: BankClient) {}
  listAccounts(query: Query = {}): Promise<unknown> {
    return this.client.request({ path: `${BANKING}/accounts`, version: 5, query });
  }
  getAccount(key: string, details = false): Promise<unknown> {
    return this.client.request({
      path: `${BANKING}/accounts/${encodeURIComponent(key)}${details ? '/details' : ''}`,
      version: 5,
    });
  }
  getAccountKeys(numbers: string[]): Promise<unknown> {
    return this.client.request({
      path: `${BANKING}/accounts/keys`,
      version: 5,
      query: { accountNumber: numbers },
    });
  }
  getBalance(accountNumber: string): Promise<unknown> {
    return this.client.request({
      path: `${BANKING}/accounts/balance`,
      version: 5,
      method: 'POST',
      body: { accountNumber },
    });
  }
  getChildAccounts(id: string): Promise<unknown> {
    return this.client.request({
      path: `${BANKING}/accounts/child/${encodeURIComponent(id)}`,
      version: 5,
    });
  }

  async listTransactions(input: TransactionOptions): Promise<unknown> {
    // These surprising query names are verbatim from the published OpenAPI.
    // Keep them explicit rather than silently guessing accountKey/transactionSource.
    const query: Query = {
      [input.classified ? 'Account keys' : 'accountKey']: input.accountKeys,
      fromDate: input.fromDate,
      toDate: input.toDate,
      rowLimit: input.rowLimit,
      'Transaction source': input.source,
      ...(input.classified ? { enrichWithMerchantLogo: input.enrichWithMerchantLogo } : {}),
    };
    const data = await this.client.request({
      path: `${BANKING}/transactions${input.classified ? '/classified' : ''}`,
      version: 1,
      query,
    });
    const body = data as Record<string, unknown>;
    if (!Array.isArray(body.transactions))
      throw new BankingError('BANK_INVALID_RESPONSE', 'Expected a transactions array.');
    return {
      ...body,
      coverage: {
        returned: body.transactions.length,
        rowLimit: input.rowLimit,
        possiblyTruncated: body.transactions.length >= input.rowLimit,
        partialFailure: Array.isArray(body.errors) && body.errors.length > 0,
        note: 'No pagination cursor is documented. A short result does not establish complete historical coverage. Narrow date windows when capped; recent and historic entries may overlap.',
      },
    };
  }
  transactionDetails(
    id: string,
    classified = false,
    enrichWithMerchantData?: boolean,
  ): Promise<unknown> {
    return this.client.request({
      path: `${BANKING}/transactions/${encodeURIComponent(id)}/details${classified ? '/classified' : ''}`,
      version: 1,
      query: classified ? { enrichWithMerchantData } : {},
    });
  }
  exportTransactions(
    accountKey: string,
    fromDate: string,
    toDate: string,
    field?: string,
  ): Promise<unknown> {
    // The specification declares fields as a single string, not an array. Expose
    // a single optional field until the bank documents multi-field serialization.
    return this.client.request({
      path: `${BANKING}/transactions/export`,
      version: 1,
      format: 'csv',
      query: { accountKey, fromDate, toDate, fields: field },
    });
  }
}
