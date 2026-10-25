import { z } from 'zod/v4';
import { toMinor } from './config.js';

// Opaque bank identifiers may contain URL-safe or standard base64 characters.
export const identifier = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_+=\/-]+$/)
  .refine((s) => s !== '.' && s !== '..', 'Invalid identifier');
export const accountNumber = z
  .string()
  .regex(/^\d{11}$/, 'Expected an unformatted 11-digit account number');
export const date = z.iso.date();
export const accountOptions = z.object({
  includeNokAccounts: z.boolean().optional(),
  includeCurrencyAccounts: z.boolean().optional(),
  includeBsuAccounts: z.boolean().optional(),
  includeCreditCardAccounts: z.boolean().optional(),
  includeAskAccounts: z.boolean().optional(),
  includePensionAccounts: z.boolean().optional(),
});
export const transactionOptions = z
  .object({
    accountKeys: z
      .array(identifier)
      .min(1)
      .max(20)
      .describe('Exact account keys returned by sb1_list_accounts.'),
    fromDate: date.optional().describe('Inclusive date in Europe/Oslo, YYYY-MM-DD.'),
    toDate: date.optional().describe('Inclusive date in Europe/Oslo, YYYY-MM-DD.'),
    rowLimit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe(
        'Bank row limit. No offset or cursor is documented. Narrow date windows if capped.',
      ),
    source: z.enum(['RECENT', 'HISTORIC', 'ALL']).optional(),
    classified: z
      .boolean()
      .default(false)
      .describe('Include bank-provided categories, subscriptions and recurring flags.'),
    enrichWithMerchantLogo: z
      .boolean()
      .optional()
      .describe('Only available for classified transactions; can increase latency.'),
  })
  .superRefine((v, ctx) => {
    if (v.fromDate && v.toDate && v.fromDate > v.toDate)
      ctx.addIssue({
        code: 'custom',
        path: ['toDate'],
        message: 'toDate must be on or after fromDate',
      });
    if (v.enrichWithMerchantLogo !== undefined && !v.classified)
      ctx.addIssue({
        code: 'custom',
        path: ['enrichWithMerchantLogo'],
        message: 'Requires classified=true',
      });
  });
export type TransactionOptions = z.infer<typeof transactionOptions>;

const amount = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/,
    'Use a positive decimal string, e.g. 125.50; at most 2 decimal places',
  )
  // Regex failures are continuable Zod issues. A pipe prevents BigInt parsing
  // until the decimal format has passed validation.
  .pipe(z.string().refine((v) => toMinor(v) > 0n, 'Amount must be positive'));
const shared = { fromAccount: accountNumber, amount, dueDate: date.optional() };
export const transferInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('account'),
      ...shared,
      toAccount: accountNumber,
      message: z.string().max(40).optional(),
      currencyCode: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('credit_card'), ...shared, creditCardAccountId: identifier }).strict(),
  z.object({ kind: z.literal('pension'), ...shared, policyNumber: identifier }).strict(),
]);
export type TransferInput = z.infer<typeof transferInput>;

export function osloToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
