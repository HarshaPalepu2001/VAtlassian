import { captureBaseline } from '../lib/capture.js';
import { collect, DETECTED_VIA } from '../lib/collect.js';
import { getReview } from '../db/itemStateStore.js';

import { retryEvent, eventTime } from './retry.js';

/** Capture consumes the recorded approval; failures remain visible and retryable. */
export async function run(event, suppliedDeps = null) {
  const runtime = suppliedDeps ?? await (await import('./runtime.js')).triggerRuntime();
  const deps = { captureBaseline, collect, getReview, ...runtime };
  const issue = event?.issue;
  if (!issue?.id || !issue?.key) return;
  const transition = resolveTransition(event);
  const issueId = Number(issue.id);
  const issueKey = String(issue.key);
  const now = Date.now();
  const transitionAt = eventTime(event) ?? now;
  const actorAccountId = event?.atlassianId ?? event?.associatedUsers?.[0]?.accountId ?? null;
  try {
    const result = await deps.captureBaseline({ issueId, issueKey, transition,
      actorAccountId, transitionAt, now });
    if (['NO_APPROVAL', 'INSUFFICIENT_ASSURANCE'].includes(result.reason)) {
      await deps.recordIncident(issueId, actorAccountId, 'UNAUTHORIZED_TRANSITION', now);
    } else if (!result.captured && !['DISABLED', 'NOT_A_GATE', 'CAPTURE_DISABLED'].includes(result.reason)) {
      await deps.recordIncident(issueId, actorAccountId, 'BASELINE_CAPTURE_FAILED', now);
      return retryEvent(event, result.reason ?? 'CAPTURE_FAILED');
    }
    // Also compare after a successful capture: a delayed/duplicate transition
    // event must not hide edits that arrived between signing and this read.
    const review = await deps.getReview(issueId);
    if (review?.baseline_id != null) {
      const observed = await deps.collect({ issueId, issueKey, detectedVia: DETECTED_VIA.EVENT,
        actorAccountId, eventId: event.eventId ?? event.id ?? null, eventAt: transitionAt, now });
      if (['ERROR', 'UNREADABLE', 'BUSY'].includes(observed.outcome)) return retryEvent(event, observed.outcome);
    }
    return result;
  } catch {
    console.error('transitioned: handler failed', JSON.stringify({ issueKey }));
    return retryEvent(event, 'TRANSITION_HANDLER_FAILED');
  }
}

/**
 * Normalise the event into { from: { id }, to: { id }, transitionId }.
 *
 * THREE SOURCES, IN ORDER OF DIRECTNESS:
 *
 *   1. `event.transition`, when the platform supplies it. Field names have
 *      varied across payload shapes (`from` / `fromStatus` / `from_status`),
 *      so all three are read rather than betting on one.
 *   2. The changelog's `status` item. A transition ALWAYS produces one, and its
 *      `from` / `to` are the numeric status ids — the same values the gate
 *      configuration stores. This is the reliable source and in practice the
 *      one that answers.
 *   3. `issue.fields.status.id` for the destination only. The issue on the
 *      event is post-transition, so its status is where the item landed. There
 *      is no equivalent fallback for the origin, which is why a missing origin
 *      is reported rather than guessed.
 *
 * `source` records which one answered, so a log line says whether the platform
 * payload is still carrying what it used to.
 */
export function resolveTransition(event) {
  const t = event?.transition ?? {};
  const from = t.from?.id ?? t.fromStatus?.id ?? t.from_status?.id ?? null;
  const to = t.to?.id ?? t.toStatus?.id ?? t.to_status?.id ?? null;
  const transitionId = t.transitionId ?? t.id ?? null;

  if (from != null && to != null) {
    return { from: { id: String(from) }, to: { id: String(to) }, transitionId, source: 'transition' };
  }

  const items = event?.changelog?.items ?? [];
  const statusItem = items.find((i) => i?.fieldId === 'status' || i?.field === 'status');
  const clFrom = statusItem?.from ?? null;
  const clTo = statusItem?.to ?? null;
  const landedOn = event?.issue?.fields?.status?.id ?? null;

  const resolvedFrom = from ?? clFrom;
  const resolvedTo = to ?? clTo ?? landedOn;

  return {
    from: resolvedFrom == null ? null : { id: String(resolvedFrom) },
    to: resolvedTo == null ? null : { id: String(resolvedTo) },
    transitionId,
    source: from != null || to != null ? 'mixed' : (clFrom != null ? 'changelog' : 'issue-status')
  };
}

function parseTime(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : null;
}
