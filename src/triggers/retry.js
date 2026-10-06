import { InvocationError, InvocationErrorCode } from '@forge/events';

// Forge allows a product event at most four retries, so the count stays at four
// for every reason and SCHEMA_PENDING waits longer between them instead: a
// capture refused because the five-minute migration job has not yet run needs
// to outlast that window, and 120+240+480+900 = 1740s does (the default
// 15+30+60+120 = 225s does not).
const BASE_DELAY = { SCHEMA_PENDING: 120 };

export function retryEvent(event, reason) {
  const count = Number(event?.retryContext?.retryCount ?? 0);
  if (count >= 4) return { retryExhausted: true, reason };
  return new InvocationError({ retryAfter: Math.min(900, (BASE_DELAY[reason] ?? 15) * (2 ** count)),
    retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
    retryData: { reason: String(reason).slice(0, 64) } });
}

export function eventTime(event) {
  const value = event?.timestamp ?? event?.changelog?.created;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
