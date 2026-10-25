import { describe, expect, it } from 'vitest';
import { readConfig, toMinor } from '../src/config.js';
import { date, osloToday, transactionOptions, transferInput } from '../src/schemas.js';

describe('input and configuration boundaries', () => {
  it.each(['NaN', 'Infinity', '1e3', 'not-money', '1,50', ''])(
    'reports invalid amount %s as validation failure without throwing',
    (amount) => {
      const result = transferInput.safeParse({
        kind: 'account',
        fromAccount: '11111111111',
        toAccount: '22222222222',
        amount,
      });
      expect(result.success).toBe(false);
    },
  );
  it('validates actual calendar dates and date order', () => {
    expect(date.safeParse('2026-02-29').success).toBe(false);
    expect(date.safeParse('2028-02-29').success).toBe(true);
    expect(
      transactionOptions.safeParse({
        accountKeys: ['key'],
        fromDate: '2026-10-25',
        toDate: '2026-10-01',
      }).success,
    ).toBe(false);
  });
  it('uses Norwegian calendar dates across UTC midnight and DST', () => {
    expect(osloToday(new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25');
    expect(osloToday(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });
  it('does not accept strings as boolean config values by truthiness', () => {
    expect(readConfig({ SB1_ENABLE_TRANSFERS: 'false' }).enableTransfers).toBe(false);
    expect(() => readConfig({ SB1_ENABLE_TRANSFERS: 'yes' })).toThrow();
  });
  it('never includes invalid secret contents in config errors', () => {
    expect(() => readConfig({ SB1_ACCESS_TOKEN: 'secret\ninjected' })).toThrow('SB1_ACCESS_TOKEN');
    try {
      readConfig({ SB1_ACCESS_TOKEN: 'secret\ninjected' });
    } catch (e) {
      expect(String(e)).not.toContain('injected');
    }
  });
  it('requires HTTPS or loopback HTTP for OAuth callbacks', () => {
    expect(() => readConfig({ SB1_REDIRECT_URI: 'http://evil.test/callback' })).toThrow();
    expect(() => readConfig({ SB1_REDIRECT_URI: 'http://127.0.0.1:8765/callback' })).not.toThrow();
    expect(() =>
      readConfig({ SB1_REDIRECT_URI: 'https://user:password@example.com/callback' }),
    ).toThrow();
  });
  it('uses exact minor units without floating-point drift', () => {
    expect(toMinor('999999999.99')).toBe(99999999999n);
    expect(toMinor('0.29')).toBe(29n);
  });
  it('rejects unrelated transfer fields and overlong payment messages', () => {
    const base = {
      kind: 'account',
      fromAccount: '11111111111',
      toAccount: '22222222222',
      amount: '1.00',
    };
    expect(transferInput.safeParse({ ...base, message: 'a'.repeat(41) }).success).toBe(false);
    expect(transferInput.safeParse({ ...base, idempotencyKey: 'invented' }).success).toBe(false);
  });
});
