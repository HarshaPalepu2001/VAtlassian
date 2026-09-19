/**
 * VAtlassian Backend Harness Logger
 *
 * Emits structured, machine-parseable log entries that the CLI harness watcher
 * can stream, parse, and highlight in real time.
 */

export function harnessLog(category, action, details = {}, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const tag = `[HARNESS:${category.toUpperCase()}]`;
  const payload = {
    timestamp,
    category,
    action,
    ...details
  };

  const line = `${tag} ${action} ${JSON.stringify(payload)}`;
  if (level === 'ERROR' || payload.error || payload.reason) {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
