export class BankingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
    public readonly outcomeUnknown = false,
    public readonly bankCodes: string[] = [],
  ) {
    super(message);
    this.name = 'BankingError';
  }
}

export function publicError(error: unknown): Record<string, unknown> {
  if (error instanceof BankingError)
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.bankCodes.length ? { bankCodes: error.bankCodes } : {}),
      ...(error.outcomeUnknown
        ? {
            outcomeUnknown: true,
            action:
              'Check online banking before making another transfer. Do not retry automatically.',
          }
        : {}),
    };
  return {
    code: 'INTERNAL_ERROR',
    message: 'The operation failed. Check local configuration and retry read operations only.',
  };
}
