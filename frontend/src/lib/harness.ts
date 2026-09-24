/**
 * VAtlassian Observability Harness (Frontend)
 *
 * Captures, buffers, and dispatches real-time telemetry for every button click,
 * resolver invoke, WebAuthn ceremony step, drift review, and restore action.
 * Exposes window.__VA_HARNESS__ for interactive inspection and quick diagnostics export.
 */

import { invoke } from './bridge';

export interface HarnessEvent {
  id: string;
  timestamp: string;
  epochMs: number;
  category: 'UI' | 'BRIDGE' | 'WEBAUTHN' | 'DRIFT' | 'RESTORE' | 'ERROR';
  action: string;
  details?: Record<string, unknown>;
  issueKey?: string;
  error?: string;
}

const MAX_BUFFER_SIZE = 120;
const eventBuffer: HarnessEvent[] = [];
let listeners: Array<(events: HarnessEvent[]) => void> = [];

const SECRET_KEYS = ['code', 'secret', 'password', 'token'];

/** Redacts at every depth. The bridge nests each resolver payload under
 *  `request`, so a top-level-only check let `request.code` — the signer's
 *  authenticator code — straight into the console and the server log. */
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
  category: HarnessEvent['category'],
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

  const event: HarnessEvent = {
    id,
    timestamp,
    epochMs,
    category,
    action,
    details: cleanDetails,
    issueKey,
    error: errorMessage
  };

  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFER_SIZE) {
    eventBuffer.shift();
  }

  // Console output for immediate developer visibility in browser DevTools
  const badgeColor = {
    UI: '#0052cc',
    BRIDGE: '#6554c0',
    WEBAUTHN: '#00875a',
    DRIFT: '#ff8b00',
    RESTORE: '#00b8d9',
    ERROR: '#de350b'
  }[category] || '#42526e';

  // eslint-disable-next-line no-console
  console.info(
    `%c[HARNESS:${category}]%c ${action}${issueKey ? ` [${issueKey}]` : ''}`,
    `background: ${badgeColor}; color: #fff; font-weight: bold; border-radius: 3px; padding: 2px 5px;`,
    'font-weight: bold; color: inherit;',
    cleanDetails,
    error ?? ''
  );

  // Notify active UI subscribers (e.g. Diagnostics HUD)
  listeners.forEach(fn => {
    try { fn([...eventBuffer]); } catch { /* ignore */ }
  });

  // Fire-and-forget beacon to backend so events appear in Forge logs for the agent
  // Skip beaconing harness:logAction itself to prevent infinite recursion
  if (action !== 'harness:logAction') {
    void invoke('harness:logAction', {
      category,
      action,
      timestamp,
      issueKey,
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

export function getHarnessEvents(): HarnessEvent[] {
  return [...eventBuffer];
}

export function exportDiagnosticsSnapshot(): string {
  const snapshot = {
    app: 'VAtlassian ALM',
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
    eventCount: eventBuffer.length,
    recentEvents: eventBuffer
  };
  return JSON.stringify(snapshot, null, 2);
}

// Attach to window for instant access from DevTools
if (typeof window !== 'undefined') {
  (window as unknown as { __VA_HARNESS__: unknown }).__VA_HARNESS__ = {
    getEvents: getHarnessEvents,
    record: recordHarnessEvent,
    export: exportDiagnosticsSnapshot,
    clear: () => { eventBuffer.length = 0; }
  };
}
