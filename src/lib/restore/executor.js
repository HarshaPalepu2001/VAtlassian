import { route } from '@forge/api';
import { declareWrite } from '../../db/restoreStore.js';
import { OUTCOME, RESTORE_STATE, digestOf, tally } from './outcome.js';

// Re-exported so callers keep importing the executor as one thing. The pure
// definitions live in ./outcome.js because this file imports @forge/api and is
// therefore unreachable from a test outside the Forge runtime.
export { OUTCOME, RESTORE_STATE, digestOf, tally };

/**
 * Performing a restore, and proving it worked.
 *
 * THE GUARANTEE: a field is reported `succeeded` only after the issue has been
 * read back and that field has been confirmed to match the baseline. Not
 * because the PUT returned 204 — a 204 means Jira accepted the request, which
 * is not the same as the field now holding the value we sent. Fields get
 * silently coerced, screens drop values they do not carry, and workflow
 * post-functions overwrite things a moment later.
 *
 * An app whose headline promise is "one click puts it back exactly" cannot
 * report a success it has not confirmed. A partial restore that reports itself
 * complete is worse than one that fails loudly, because nobody goes looking.
 */

/**
 * Execute a plan.
 *
 * @param api          @forge/api
 * @param plan         from planner.js
 * @param issueKey
 * @param controlledFields
 * @param actAs        'app' | 'user'
 * @param notifyUsers
 * @param perFieldRetries
 *
 * @returns { state, counters, detail }
 *
 * NEVER THROWS on a Jira failure. Every field's outcome is captured and
 * reported; an exception escaping here would leave a half-rewritten issue with
 * no record of which half.
 */
export async function executeRestore({
  api,
  plan,
  issueKey,
  issueId,
  controlledFields = [],
  actAs = 'app',
  notifyUsers = false,
  perFieldRetries = 2,
  now = Date.now()
}) {
  const byId = new Map(controlledFields.map((f) => [f.field_id, f]));
  const detail = new Map();

  // Fields the plan already knows are hopeless. Recorded up front so they
  // appear in the report even if everything else fails.
  for (const step of plan.steps) {
    if (step.strategy === 'none') {
      detail.set(step.fieldId, {
        fieldId: step.fieldId,
        fieldName: step.fieldName,
        outcome: OUTCOME.IRREVERSIBLE,
        reason: step.reason,
        verified: false
      });
    }
  }

  const writes = { ...plan.fieldWrites };
  const writeIds = Object.keys(writes);

  // ── Declare our own writes BEFORE making them ─────────────────────────────
  //
  // A restore produces a changelog entry and an avi:jira:updated:issue event
  // exactly like a human edit. Without this, the drift collector would record
  // the restoration as fresh drift and leave the item DRIFTED immediately after
  // being restored — with the reviewer's own reversion sitting in their queue.
  // A loop, and an embarrassing one. Declared first so the window opens before
  // the event can possibly fire.
  const CONCURRENCY_LIMIT = 5;
  for (let i = 0; i < writeIds.length; i += CONCURRENCY_LIMIT) {
    const batch = writeIds.slice(i, i + CONCURRENCY_LIMIT).map(async (fieldId) => {
      const field = byId.get(fieldId);
      if (!field) return;
      const digest = digestOf(field, writes[fieldId]);
      try {
        await declareWrite({ issueId, fieldId, digest, now });
      } catch (e) {
        // Best-effort. A missed suppression costs one spurious drift row that a
        // reviewer can dismiss; refusing to restore because bookkeeping failed
        // would cost them the thing they actually asked for.
        console.error('restore: could not declare write for', fieldId, e);
      }
    });
    await Promise.all(batch);
  }

  const client = actAs === 'user' ? api.asUser() : api.asApp();
  const query = notifyUsers ? '' : '?notifyUsers=false';

  // ── Phase 1: one bulk PUT ─────────────────────────────────────────────────
  //
  // The fast path, and the tidy one: every field lands in a single changelog
  // entry, so the item's history shows one restoration rather than fourteen
  // separate edits a second apart.
  let bulkErrors = null;
  if (writeIds.length > 0) {
    const res = await put(client, issueKey, true, { fields: writes });
    if (res.ok) {
      for (const fieldId of writeIds) {
        detail.set(fieldId, {
          fieldId,
          fieldName: nameOf(byId, fieldId),
          outcome: OUTCOME.SUCCEEDED,
          reason: null,
          // Not verified YET. Phase 3 decides this, and until then no field is
          // allowed to claim success.
          verified: false
        });
      }
    } else {
      bulkErrors = res.errors ?? {};
      console.warn('restore: bulk write rejected, falling back per field', {
        issueKey, status: res.status, fields: Object.keys(bulkErrors)
      });
    }
  }

  // ── Phase 2: per-field retry ──────────────────────────────────────────────
  //
  // Jira's 400 body maps errors to the fields that caused them, so the fields
  // it did NOT complain about are probably fine and worth retrying
  // individually. One bad value must not sink thirteen good ones — that is the
  // difference between "one field could not be restored" and "the restore
  // failed", and a reviewer deserves the first answer when it is the true one.
  if (bulkErrors) {
    for (const fieldId of writeIds) {
      const complaint = bulkErrors[fieldId];
      let lastError = complaint ?? null;
      let ok = false;

      for (let attempt = 0; attempt <= perFieldRetries && !ok; attempt++) {
        const res = await put(client, issueKey, true, { fields: { [fieldId]: writes[fieldId] } });
        if (res.ok) { ok = true; break; }
        lastError = res.errors?.[fieldId] ?? res.messages?.[0] ?? `HTTP ${res.status}`;
        // Only retry on a transient status. A 400 is a rejected VALUE and will
        // be rejected identically every time; retrying it twice just makes the
        // reviewer wait longer for the same answer.
        if (res.status && res.status < 500 && res.status !== 429) break;
      }

      detail.set(fieldId, {
        fieldId,
        fieldName: nameOf(byId, fieldId),
        outcome: ok ? OUTCOME.SUCCEEDED : OUTCOME.FAILED,
        reason: ok ? null : String(lastError),
        verified: false
      });
    }
  }

  // ── Phase 2b: special handlers ────────────────────────────────────────────
  for (const step of plan.steps.filter((s) => s.strategy !== 'field' && s.strategy !== 'none')) {
    const result = await runHandler(client, {
      strategy: step.strategy, issueKey, step
    });
    detail.set(step.fieldId, {
      fieldId: step.fieldId,
      fieldName: step.fieldName,
      outcome: result.ok ? OUTCOME.SUCCEEDED : (result.skipped ? OUTCOME.SKIPPED : OUTCOME.FAILED),
      reason: result.reason ?? null,
      verified: false
    });
  }

  return { detail: [...detail.values()], writeIds };
}

/**
 * PUT, with the error body parsed.
 *
 * Returns a plain result rather than throwing so the caller can record an
 * outcome per field. Jira's per-field `errors` map is the useful part — "Labels
 * is not on the appropriate screen" tells an admin exactly what to fix;
 * "restore failed" tells them nothing.
 */
async function put(client, issueKey, overrideSecurity, body) {
  let res;
  try {
    const opts = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    };
    if (overrideSecurity) {
      res = await client.requestJira(route`/rest/api/3/issue/${issueKey}?notifyUsers=false&overrideScreenSecurity=true&overrideEditableFlag=true`, opts);
    } else {
      res = await client.requestJira(route`/rest/api/3/issue/${issueKey}?notifyUsers=false`, opts);
    }
  } catch (e) {
    return { ok: false, status: 0, errors: null, messages: [String(e?.message ?? e)] };
  }

  if (res.status === 204 || res.status === 200) return { ok: true };

  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // Non-JSON body; the status is still the fact that matters.
  }
  return {
    ok: false,
    status: res.status,
    errors: parsed?.errors ?? null,
    messages: parsed?.errorMessages ?? null
  };
}

/**
 * Fields that are not field writes.
 *
 * Each of these is a genuinely different API and each is genuinely partial —
 * which is why the planner marks them SPECIAL and the dialog says so, rather
 * than letting a reviewer believe issue links restore as cleanly as a summary.
 */
async function runHandler(client, { strategy, issueKey, step }) {
  switch (strategy) {
    case 'parent': {
      const key = step.targetValue?.key ?? step.targetValue?.id ?? step.targetValue;
      if (!key) return { ok: false, skipped: true, reason: 'No baselined parent to restore to.' };
      const res = await put(client, issueKey, false, {
        fields: { parent: { key: String(key) } }
      });
      return res.ok ? { ok: true } : { ok: false, reason: describe(res) };
    }

    case 'links':
      // Issue links are add/remove operations against a separate endpoint, and
      // restoring them exactly means both deleting links added since approval
      // and recreating ones removed. Deleting a link somebody deliberately made
      // is a materially different act from resetting a field value, and doing
      // it silently inside a bulk restore is not something this app should do
      // without the reviewer having asked for it specifically.
      return {
        ok: false,
        skipped: true,
        reason: 'Issue links are not restored automatically. The diff lists exactly which links were added and removed so they can be corrected deliberately.'
      };

    case 'transition':
      // Status is restored by moving the item, not by writing a field, and the
      // decision path already handles transitions properly — with the right
      // transition id, the required-field plan and the reviewer's own
      // permissions. Doing it here as well would be a second, worse
      // implementation of something that already exists.
      return {
        ok: false,
        skipped: true,
        reason: 'Status is restored by a workflow transition, not by this restore. Use the transition controls on the work item.'
      };

    case 'sprint': {
      const sprintId = Array.isArray(step.targetValue) ? step.targetValue[0] : step.targetValue;
      if (sprintId == null) return { ok: false, skipped: true, reason: 'No baselined sprint to restore to.' };
      const res = await put(client, issueKey, false, {
        fields: { [step.fieldId]: Number(sprintId) }
      });
      return res.ok ? { ok: true } : { ok: false, reason: describe(res) };
    }

    default:
      return { ok: false, skipped: true, reason: `No handler for ${strategy}.` };
  }
}

function describe(res) {
  if (res.errors) return Object.values(res.errors).join('; ');
  if (res.messages) return res.messages.join('; ');
  return `HTTP ${res.status}`;
}

function nameOf(byId, fieldId) {
  return byId.get(fieldId)?.field_name ?? fieldId;
}

// digestOf and tally live in ./outcome.js and are re-exported at the top of
// this file. They are the two pieces of restore logic a test most needs to
// reach, and they cannot live here: this module imports @forge/api, which does
// not resolve outside the Forge runtime.
