export type Result = { success?: boolean; ok?: boolean; error?: string; message?: string; note?: string; reason?: string };
export function assertResult<T extends Result>(result: T): T {
  if (result.success === false || result.ok === false || result.error) throw new Error(result.error || result.message || result.reason || 'The request did not complete.');
  return result;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The request did not complete. Please retry.'; }
export function download(name: string, value: unknown, mime = 'application/json') {
  const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type: mime });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
