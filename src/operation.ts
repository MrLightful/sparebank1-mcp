import { AsyncLocalStorage } from 'node:async_hooks';

// Each concurrent MCP call carries its own cancellation signal. Token rotation
// remains independent so one cancelled read cannot interrupt a shared refresh.
export const operation = new AsyncLocalStorage<{ signal: AbortSignal }>();
