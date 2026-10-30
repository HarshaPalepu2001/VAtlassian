/**
 * Frontend telemetry for clicks, resolver calls, WebAuthn, drift and restores.
 * window.__VA_HARNESS__ supports inspection and diagnostics export.
 */

import { invoke } from './bridge';

export type HarnessCategory =
  | 'UI'
  | 'BRIDGE'
  | 'WEBAUTHN'
  | 'DRIFT'
  | 'RESTORE'
  | 'GATE'
  | 'VAULT'
  | 'DIAGNOSTICS'
  | 'RESOLVER'
  | 'ADMIN'
  | 'CAPTURE'
  | 'APPROVAL'
  | 'TRIGGER'
  | 'AUDIT'
  | 'ERROR';

export interface HarnessEvent {
  id: string;
  timestamp: string;
  epochMs: number;
  category: HarnessCategory;
  action: string;
  details?: Record<string, unknown>;
  issueKey?: string;
  traceId?: string;
  durationMs?: number;
  error?: string;
}

const MAX_BUFFER_SIZE = 200;
const eventBuffer: HarnessEvent[] = [];
let listeners: Array<(events: HarnessEvent[]) => void> = [];

let activeTraceId: string | null = null;

export function createTraceId(): string {
  return `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function getActiveTraceId(): string | null {
  return activeTraceId;
}

export function setActiveTraceId(traceId: string | null): void {
  activeTraceId = traceId;
}

export function withTrace<T>(traceId: string, fn: () => T): T {
  const previous = activeTraceId;
  activeTraceId = traceId;
  try {
    return fn();
  } finally {
    activeTraceId = previous;
  }
}

const SECRET_KEYS = ['code', 'secret', 'password', 'token', 'totp', 'authorization', 'signature'];

/**
 * Redact nested payloads too. Checking only top-level keys exposed
 * request.code, the signer's authenticator code, in console and server logs.
 */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    sanitized[key] = SECRET_KEYS.includes(key.toLowerCase()) && typeof inner === 'string'
      ? (inner ? `[REDACTED_LEN_${inner.length}]` : '[EMPTY]')
      : sanitizeValue(inner, depth + 1);
  }
  return sanitized;
}

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> {
  if (!details) return {};
  return sanitizeValue(details, 0) as Record<string, unknown>;
}

export function recordHarnessEvent(
  category: HarnessCategory,
  action: string,
  details?: Record<string, unknown>,
  error?: unknown
): HarnessEvent {
  const epochMs = Date.now();
  const timestamp = new Date(epochMs).toISOString();
  const id = `${epochMs}-${Math.random().toString(36).slice(2, 7)}`;
  const cleanDetails = sanitizeDetails(details);
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
  const issueKey = (cleanDetails.issueKey ?? cleanDetails.targetKey ?? cleanDetails.rootIssueKey) as string | undefined;
  const traceId = (cleanDetails.traceId as string | undefined) ?? activeTraceId ?? undefined;
  const durationMs = typeof cleanDetails.durationMs === 'number' ? cleanDetails.durationMs : undefined;

  const event: HarnessEvent = {
    id,
    timestamp,
    epochMs,
    category,
    action,
    details: cleanDetails,
    issueKey,
    traceId,
    durationMs,
    error: errorMessage
  };

  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFER_SIZE) {
    eventBuffer.shift();
  }

  // Console output for developer visibility in browser DevTools
  const badgeColor: Record<string, string> = {
    UI: '#0052cc',
    BRIDGE: '#6554c0',
    WEBAUTHN: '#00875a',
    DRIFT: '#ff8b00',
    RESTORE: '#00b8d9',
    GATE: '#ffab00',
    VAULT: '#8777d9',
    DIAGNOSTICS: '#00b8d9',
    RESOLVER: '#0052cc',
    ADMIN: '#0747a6',
    CAPTURE: '#00a3bf',
    APPROVAL: '#36b37e',
    ERROR: '#de350b'
  };

  // eslint-disable-next-line no-console
  console.info(
    `%c[HARNESS:${category}]%c ${action}${issueKey ? ` [${issueKey}]` : ''}`,
    `background: ${badgeColor[category] || '#42526e'}; color: #fff; font-weight: bold; border-radius: 3px; padding: 2px 5px;`,
    'font-weight: bold; color: inherit;',
    cleanDetails,
    error ?? ''
  );

  // Notify active UI subscribers (e.g. Diagnostics HUD)
  listeners.forEach(fn => {
    try { fn([...eventBuffer]); } catch { /* ignore */ }
  });

  // Send telemetry to Forge logs without waiting for a response.
  // Skip harness:logAction to avoid recursion. Successful resolver calls are
  // already logged by lib/harnessLogger.js with duration and outcome. Send
  // transport failures ending in :failed because they never reached that logger.
  const serverLogged = action.startsWith('invoke:') && !action.endsWith(':failed');
  if (action !== 'harness:logAction' && !serverLogged) {
    void invoke('harness:logAction', {
      category,
      action,
      timestamp,
      issueKey,
      traceId,
      details: cleanDetails,
      error: errorMessage
    }).catch(() => {});
  }

  return event;
}

export function subscribeHarnessEvents(callback: (events: HarnessEvent[]) => void): () => void {
  listeners.push(callback);
  callback([...eventBuffer]);
  return () => {
    listeners = listeners.filter(l => l !== callback);
  };
}

export function getHarnessEvents(filter?: {
  category?: string;
  issueKey?: string;
  errorOnly?: boolean;
  traceId?: string;
  search?: string;
}): HarnessEvent[] {
  if (!filter) return [...eventBuffer];

  return eventBuffer.filter(e => {
    if (filter.category && filter.category !== 'ALL' && e.category !== filter.category) return false;
    if (filter.issueKey && e.issueKey?.toUpperCase() !== filter.issueKey.toUpperCase()) return false;
    if (filter.errorOnly && e.category !== 'ERROR' && !e.error) return false;
    if (filter.traceId && e.traceId !== filter.traceId) return false;
    if (filter.search) {
      const q = filter.search.toLowerCase();
      const matchAction = e.action.toLowerCase().includes(q);
      const matchDetails = JSON.stringify(e.details || {}).toLowerCase().includes(q);
      if (!matchAction && !matchDetails) return false;
    }
    return true;
  });
}

export function getHarnessStats(): {
  total: number;
  byCategory: Record<string, number>;
  errorCount: number;
  avgBridgeDurationMs: number;
} {
  const byCategory: Record<string, number> = {};
  let errorCount = 0;
  let bridgeDurationSum = 0;
  let bridgeCount = 0;

  for (const e of eventBuffer) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    if (e.category === 'ERROR' || e.error) errorCount++;
    if (e.category === 'BRIDGE' && typeof e.durationMs === 'number') {
      bridgeDurationSum += e.durationMs;
      bridgeCount++;
    }
  }

  return {
    total: eventBuffer.length,
    byCategory,
    errorCount,
    avgBridgeDurationMs: bridgeCount > 0 ? Math.round(bridgeDurationSum / bridgeCount) : 0
  };
}

export function exportDiagnosticsSnapshot(): string {
  const snapshot = {
    app: 'VAtlassian ALM',
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
    stats: getHarnessStats(),
    eventCount: eventBuffer.length,
    recentEvents: eventBuffer
  };
  return JSON.stringify(snapshot, null, 2);
}

// Attach to window for instant access from DevTools
if (typeof window !== 'undefined') {
  (window as unknown as { __VA_HARNESS__: unknown }).__VA_HARNESS__ = {
    getEvents: getHarnessEvents,
    getStats: getHarnessStats,
    record: recordHarnessEvent,
    createTrace: createTraceId,
    withTrace,
    export: exportDiagnosticsSnapshot,
    clear: () => { eventBuffer.length = 0; }
  };
}
