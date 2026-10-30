/**
 * VAtlassian Backend Harness Logger & Instrumentation
 *
 * Emits structured, machine-parseable log entries that the CLI harness watcher
 * and Diagnostics HUD can stream, parse, and analyze in real time.
 * Supports trace propagation, asynchronous duration profiling, secret redaction,
 * and universal resolver middleware.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { withRequestCache } from './cache.js';

export const HARNESS_CATEGORIES = {
  GATE: 'GATE',
  CAPTURE: 'CAPTURE',
  DRIFT: 'DRIFT',
  APPROVAL: 'APPROVAL',
  WEBAUTHN: 'WEBAUTHN',
  RESTORE: 'RESTORE',
  VAULT: 'VAULT',
  RESOLVER: 'RESOLVER',
  ADMIN: 'ADMIN',
  TRIGGER: 'TRIGGER',
  WORKER: 'WORKER',
  DIAGNOSTICS: 'DIAGNOSTICS',
  AUDIT: 'AUDIT',
  CLIENT: 'CLIENT',
  UI: 'UI',
  BRIDGE: 'BRIDGE',
  ERROR: 'ERROR'
};

const traceStorage = new AsyncLocalStorage();

/**
 * Execute an asynchronous function within a bound trace context.
 */
export function withTrace(traceId, fn) {
  if (!traceId) return fn();
  return traceStorage.run(String(traceId), fn);
}

/**
 * Retrieve the active trace ID from AsyncLocalStorage, or null if none.
 */
export function currentTraceId() {
  return traceStorage.getStore() ?? null;
}

const SECRET_KEYS = new Set(['code', 'secret', 'password', 'token', 'totp', 'authorization', 'signature']);

/**
 * Recursively sanitize objects, redacting sensitive secrets and extracting Error details.
 */
export function sanitizeHarnessDetails(details, depth = 0) {
  if (details instanceof Error) {
    return {
      name: details.name,
      message: details.message,
      code: details.code,
      ...(details.status ? { status: details.status } : {}),
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.suggestion ? { suggestion: details.suggestion } : {}),
      ...(details.context?.debug ? { debug: sanitizeHarnessDetails(details.context.debug, depth + 1) } : {}),
      stack: details.stack ? details.stack.split('\n').slice(0, 3).join('\n') : undefined
    };
  }
  if (depth > 6 || details === null || typeof details !== 'object') return details;
  if (Array.isArray(details)) return details.map(item => sanitizeHarnessDetails(item, depth + 1));
  if (Object.getPrototypeOf(details) !== Object.prototype) return details;

  const sanitized = {};
  for (const [key, inner] of Object.entries(details)) {
    sanitized[key] = SECRET_KEYS.has(key.toLowerCase()) && typeof inner === 'string'
      ? (inner ? `[REDACTED_LEN_${inner.length}]` : '[EMPTY]')
      : sanitizeHarnessDetails(inner, depth + 1);
  }
  return sanitized;
}

/**
 * Emit a structured harness log entry.
 */
export function harnessLog(category, action, details = {}, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const categoryTag = (category || 'UNKNOWN').toUpperCase();
  const tag = `[HARNESS:${categoryTag}]`;
  const activeTrace = details.traceId ?? currentTraceId();
  const cleanDetails = sanitizeHarnessDetails(details);
  const emittedLevel = level === 'ERROR' || cleanDetails.error || cleanDetails.reason
    ? 'ERROR' : level === 'WARN' ? 'WARN' : 'INFO';

  const payload = {
    timestamp,
    category: categoryTag,
    action,
    ...(activeTrace ? { traceId: activeTrace } : {}),
    ...cleanDetails,
    level: emittedLevel
  };

  const line = `${tag} ${action} ${JSON.stringify(payload)}`;
  if (emittedLevel === 'ERROR') {
    console.error(line);
  } else if (emittedLevel === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Profile an async function, automatically logging start, durationMs, and outcome.
 */
export async function timeAsync(category, action, details = {}, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    harnessLog(category, action, { ...details, durationMs, success: true }, 'INFO');
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    harnessLog(category, `${action}:failed`, {
      ...details,
      durationMs,
      success: false,
      error: error?.message || String(error)
    }, 'ERROR');
    throw error;
  }
}

/**
 * Universal harness resolver wrapper.
 * Instruments Forge resolver definitions with duration tracking, trace propagation,
 * input sanitization, and structured error reporting.
 */
export function wrapWithHarness(definitions, { resolverName = 'resolver' } = {}) {
  return async (...args) => {
    const req = args[0];
    const functionKey = req?.call?.functionKey || 'unknown';
    const isHarnessLog = functionKey === 'harness:logAction';
    const traceId = req?.payload?.traceId || req?.context?.traceId || req?.payload?.requestId;
    const startedAt = Date.now();

    const execute = async () => {
      try {
        const result = await withRequestCache(() => definitions(...args), { label: `${resolverName}:${functionKey}` });
        const durationMs = Date.now() - startedAt;

        if (!isHarnessLog) {
          const isSuccess = result?.success !== false && result?.ok !== false && !result?.error;
          // Measuring, never replacing, what is returned: a response that
          // cannot be stringified (none seen in practice; every resolver
          // returns a plain JSON-safe object) must not turn an otherwise
          // successful call into a thrown error over a log field.
          let responseBytes;
          try {
            responseBytes = Buffer.byteLength(JSON.stringify(result ?? null), 'utf8');
          } catch {
            responseBytes = null;
          }
          harnessLog(isSuccess ? 'RESOLVER' : 'ERROR', `resolver:${functionKey}`, {
            resolverName,
            functionKey,
            durationMs,
            responseBytes,
            issueKey: req?.payload?.issueKey ?? req?.payload?.issueId ?? req?.context?.extension?.issue?.key,
            accountId: req?.context?.accountId,
            success: isSuccess,
            reason: result?.reason,
            error: result?.error,
            transitioned: result?.transitioned
          }, isSuccess ? 'INFO' : 'WARN');
        }
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        harnessLog('ERROR', `resolver:${functionKey}:failed`, {
          resolverName,
          functionKey,
          durationMs,
          issueKey: req?.payload?.issueKey ?? req?.payload?.issueId ?? req?.context?.extension?.issue?.key,
          accountId: req?.context?.accountId,
          error: error?.message || String(error),
          reason: error?.reason
        }, 'ERROR');
        throw error;
      }
    };

    return traceId ? withTrace(traceId, execute) : execute();
  };
}
