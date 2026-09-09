import { InvocationError, InvocationErrorCode } from '@forge/events';

export function retryEvent(event, reason) {
  const count = Number(event?.retryContext?.retryCount ?? 0);
  if (count >= 4) return { retryExhausted: true, reason };
  return new InvocationError({ retryAfter: Math.min(900, 15 * (2 ** count)),
    retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
    retryData: { reason: String(reason).slice(0, 64) } });
}

export function eventTime(event) {
  const value = event?.timestamp ?? event?.changelog?.created;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
