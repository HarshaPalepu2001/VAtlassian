export type Result = {
  success?: boolean; ok?: boolean; error?: string; message?: string; note?: string; reason?: string;
  /** Set only when the resolver's own error carried them (an upstream 429/503, mainly) — never fabricated. */
  status?: number; retryAfterMs?: number;
};
/** Thrown by assertResult. Plain `Error` for every existing catch, plus the
 *  backoff fields a caller can check before deciding whether and when to retry. */
export class ResultError extends Error {
  reason?: string; status?: number; retryAfterMs?: number;
  constructor(message: string, result: Result) {
    super(message);
    this.name = 'ResultError';
    this.reason = result.reason;
    this.status = result.status;
    this.retryAfterMs = result.retryAfterMs;
  }
}
export function assertResult<T extends Result>(result: T): T {
  if (result.success === false || result.ok === false || result.error) {
    throw new ResultError(result.error || result.message || result.reason || 'The request did not complete.', result);
  }
  return result;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The request did not complete. Please retry.'; }
export function download(name: string, value: unknown, mime = 'application/json') {
  const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type: mime });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
