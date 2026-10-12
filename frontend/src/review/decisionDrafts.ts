import type { Decisions, Choice } from './fieldDecisions';

const PREFIX = 'vatlassian:review-decision-draft:';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function storageKey(issueKey: string, evidenceHash: string): string {
  return `${PREFIX}${encodeURIComponent(issueKey)}:${encodeURIComponent(evidenceHash)}`;
}

function validState(value: unknown): Decisions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state: Decisions = {};
  for (const [fieldId, decision] of Object.entries(value)) {
    if (decision === 'APPROVE' || decision === 'REJECT') state[fieldId] = decision as Choice;
  }
  return state;
}

export function loadDecisionDraft(issueKey: string, evidenceHash: string): Decisions | null {
  const store = storage();
  if (!store || !issueKey || !evidenceHash) return null;
  try {
    const raw = store.getItem(storageKey(issueKey, evidenceHash));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { evidenceHash?: unknown; state?: unknown };
    if (parsed.evidenceHash !== evidenceHash) return null;
    return validState(parsed.state);
  } catch {
    return null;
  }
}

export function saveDecisionDraft(issueKey: string, evidenceHash: string, state: Decisions): void {
  const store = storage();
  if (!store || !issueKey || !evidenceHash) return;
  try {
    const key = storageKey(issueKey, evidenceHash);
    if (Object.keys(state).length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ evidenceHash, state }));
  } catch {
    // Draft persistence is a convenience only; private browsing and quota
    // restrictions must never prevent the review itself from working.
  }
}

export function clearDecisionDraft(issueKey: string, evidenceHash: string): void {
  const store = storage();
  if (!store || !issueKey || !evidenceHash) return;
  try { store.removeItem(storageKey(issueKey, evidenceHash)); } catch { /* best effort */ }
}
