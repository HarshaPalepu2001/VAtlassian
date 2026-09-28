import { findLinkConflicts, describeLinkConflicts } from './linkConflicts.js';
import { route } from '@forge/api';
import { declareWrite } from '../../db/restoreStore.js';
import { OUTCOME, RESTORE_STATE, digestOf, tally } from './outcome.js';
import { restoreAttachments, pointAtLiveFiles, explainRichTextRefusal } from './attachments.js';

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
 * @param actorAccountId, approvalId  the signed rejection, for the audit
 *                     entries an attachment restore writes
 * @param attachmentDeps  I/O for ./attachments.js; built from `api` if absent
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
  now = Date.now(),
  actorAccountId = 'system',
  approvalId = null,
  attachmentDeps = null,
  // The other end's approved links, so a link restore never contradicts it
  // (./linkConflicts.js). Absent: no end is checked, as before.
  approvedLinksOf = null
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
  const write = { notifyUsers, override: actAs !== 'user' };

  // ── Phase 0: files, before any rich text ──────────────────────────────────
  //
  // A description that shows a file can only be written while Jira has that
  // file. So removed files are uploaded again first, and then every rich-text
  // value about to be written points at the files that are there: unchanged
  // where the original survives (byte for byte), the restored copy where it
  // did not. The digests declared above are of the approved values, which is
  // what a canonical read of the result compares against.
  const attachments = async () => attachmentDeps
    ?? (await import('./attachmentAdapters.js')).createAttachmentRestoreDeps({ api, route, actorAccountId, approvalId });
  const fileStep = plan.steps.find((s) => s.strategy === 'attachments');
  if (fileStep) {
    const result = await runHandler(client, { strategy: 'attachments', issueKey, issueId, step: fileStep, write, attachments });
    detail.set(fileStep.fieldId, { fieldId: fileStep.fieldId, fieldName: fileStep.fieldName,
      outcome: result.ok ? OUTCOME.SUCCEEDED : OUTCOME.FAILED, reason: result.reason ?? null, verified: false });
  }
  if (writeIds.length > 0 && (fileStep || Object.values(writes).some(v => v && typeof v === 'object' && v.type === 'doc'))) {
    try {
      const deps = await attachments();
      Object.assign(writes, pointAtLiveFiles(writes, deps.identity ? await deps.identity(issueId) : null));
    } catch (e) {
      console.error('restore: could not read restored copies; rich text is written as approved', e);
    }
  }

  // ── Phase 1: one bulk PUT ─────────────────────────────────────────────────
  //
  // The fast path, and the tidy one: every field lands in a single changelog
  // entry, so the item's history shows one restoration rather than fourteen
  // separate edits a second apart.
  let bulkErrors = null;
  if (writeIds.length > 0) {
    const res = await put(client, issueKey, write, { fields: writes });
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
    const badIds = Object.keys(bulkErrors);
    const goodIds = writeIds.filter(id => !badIds.includes(id));
    
    // Try a second bulk write with only the fields Jira did not complain about
    if (goodIds.length > 0) {
      const goodWrites = {};
      for (const id of goodIds) goodWrites[id] = writes[id];
      const res2 = await put(client, issueKey, write, { fields: goodWrites });
      if (res2.ok) {
        for (const id of goodIds) {
          detail.set(id, { fieldId: id, fieldName: nameOf(byId, id), outcome: OUTCOME.SUCCEEDED, reason: null, verified: false });
        }
      }
    }

    for (const fieldId of writeIds) {
      if (detail.has(fieldId)) continue; // Already succeeded in second bulk write
      const complaint = bulkErrors[fieldId];
      let lastError = complaint ?? null;
      let ok = false;

      for (let attempt = 0; attempt <= perFieldRetries && !ok; attempt++) {
        const res = await put(client, issueKey, write, { fields: { [fieldId]: writes[fieldId] } });
        if (res.ok) { ok = true; break; }
        lastError = res.errors?.[fieldId] ?? res.messages?.[0] ?? `HTTP ${res.status}`;
        if (res.status && res.status < 500 && res.status !== 429) break;
      }

      detail.set(fieldId, {
        fieldId,
        fieldName: nameOf(byId, fieldId),
        outcome: ok ? OUTCOME.SUCCEEDED : OUTCOME.FAILED,
        reason: ok ? null : String(explainRichTextRefusal(String(lastError))),
        verified: false
      });
    }
  }

  // ── Phase 2b: special handlers ────────────────────────────────────────────
  for (const step of plan.steps.filter((s) => s.strategy !== 'field' && s.strategy !== 'none' && s.strategy !== 'attachments')) {
    const result = await runHandler(client, {
      strategy: step.strategy, issueKey, issueId, step, write, attachments, approvedLinksOf
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
 *
 * THE OVERRIDE IS WHY A 100-FIELD BASELINE CAN ACTUALLY REVERT. The tracked set
 * is every field the administrator declared (see lib/trackedFields.js), and a
 * declared field is not necessarily on this issue type's edit screen. Without
 * overrideScreenSecurity those fields are baselined, diffed and shown to the
 * reviewer — and then silently refused at the one moment the reviewer asked for
 * them back. Both parameters require Jira administrator permission, so they are
 * sent ONLY on the app-attributed path; asUser() would take a 403 for a
 * reviewer who is not an admin, which is worse than not asking.
 */
async function put(client, issueKey, { notifyUsers, override }, body) {
  let res;
  try {
    const opts = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    };
    // Written out rather than assembled: route`` percent-encodes every
    // substitution, so an interpolated query string arrives as literal
    // "%3FnotifyUsers%3Dfalse" and Jira reads none of it.
    if (notifyUsers && override) {
      res = await client.requestJira(route`/rest/api/3/issue/${issueKey}?overrideScreenSecurity=true&overrideEditableFlag=true`, opts);
    } else if (notifyUsers) {
      res = await client.requestJira(route`/rest/api/3/issue/${issueKey}`, opts);
    } else if (override) {
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
async function runHandler(client, { strategy, issueKey, issueId, step, write, attachments, approvedLinksOf = null }) {
  switch (strategy) {
    case 'attachments':
      // Always as the app: the vault is private to it, and on a project whose
      // attachment deletion is locked only the app's own account may delete.
      try {
        await restoreAttachments({ issueKey, issueId, target: step.targetValue, deps: await attachments() });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error?.detail ?? error?.message ?? error) };
      }

    case 'parent': {
      const value = step.targetValue;
      let parent = null;
      if (value !== null) {
        if (value?.id != null) parent = { id: String(value.id) };
        else if (value?.key != null) parent = { key: String(value.key) };
        else if (typeof value === 'string' || typeof value === 'number') {
          parent = /^\d+$/.test(String(value)) ? { id: String(value) } : { key: String(value) };
        } else return { ok: false, reason: 'The approved parent is missing its issue id or key.' };
      }
      const res = await put(client, issueKey, write, { fields: { parent } });
      return res.ok ? { ok: true } : { ok: false, reason: describe(res) };
    }

    case 'links':
      return restoreLinks(client, issueKey, step.targetValue, { issueId, approvedLinksOf });

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
      const res = await put(client, issueKey, write, {
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

/** Reconcile Jira issue links by type, direction and linked issue identity.
 * API: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/
 * Link IDs are ephemeral; recreated relationships acquire a new ID.
 */
async function restoreLinks(client, issueKey, target, { issueId = null, approvedLinksOf = null } = {}) {
  try {
    if (!Array.isArray(target)) return { ok: false, reason: 'The stored issue links are not a complete raw link list.' };
    const read = await client.requestJira(route`/rest/api/3/issue/${issueKey}?fields=issuelinks`);
    if (!read.ok) return { ok: false, reason: `Issue links could not be read (HTTP ${read.status}).` };
    const body = await read.json();
    const current = body?.fields?.issuelinks;
    if (!Array.isArray(current)) return { ok: false, reason: 'Jira omitted the current issue links; no links were changed.' };
    // Validate both complete lists before any mutation. A malformed stored
    // entry must never become permission to delete a real relationship.
    const desired = new Map(target.map(link => [linkIdentity(link), link]));
    const existing = new Map(current.map(link => [linkIdentity(link), link]));
    // A link belongs to both ends: a change the other end's approved state
    // forbids is left exactly as it is, and the outcome says so.
    const conflicts = await findLinkConflicts({ selfIssueId: body?.id ?? issueId ?? issueKey,
      additions: [...desired].filter(([key]) => !existing.has(key)).map(([, link]) => link),
      removals: [...existing].filter(([key]) => !desired.has(key)).map(([, link]) => link),
      approvedLinksOf });
    const held = new Set(conflicts.map(c => linkIdentity(c.link)));
    const additions = [...desired].filter(([key]) => !existing.has(key) && !held.has(key));
    const removals = [...existing].filter(([key]) => !desired.has(key) && !held.has(key));
    if (removals.some(([, link]) => !link.id)) return { ok: false, reason: 'A current issue link has no deletion id; the link set cannot be restored exactly.' };
    // Add first: a refused missing relationship leaves existing links intact.
    for (const [, link] of additions) {
      const direction = link.inwardIssue ? 'inwardIssue' : 'outwardIssue';
      const opposite = direction === 'inwardIssue' ? 'outwardIssue' : 'inwardIssue';
      const other = link[direction];
      const body = { type: link.type.id != null ? { id: String(link.type.id) } : { name: link.type.name },
        [direction]: other.id != null ? { id: String(other.id) } : { key: other.key },
        [opposite]: { key: issueKey } };
      const res = await client.requestJira(route`/rest/api/3/issueLink`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
      });
      if (!res.ok) return { ok: false, reason: `An approved issue link could not be recreated (HTTP ${res.status}).` };
    }
    for (const [, link] of removals) {
      const res = await client.requestJira(route`/rest/api/3/issueLink/${link.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) return { ok: false, reason: `An added issue link could not be removed (HTTP ${res.status}).` };
    }
    if (conflicts.length) return { ok: false, reason: describeLinkConflicts(conflicts) };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Issue links could not be restored: ${error.message ?? error}` };
  }
}

function linkIdentity(link) {
  const direction = link?.inwardIssue ? 'inwardIssue' : 'outwardIssue';
  const other = link?.[direction];
  const type = link?.type?.id ?? link?.type?.name;
  if (!type || !other || !(other.id ?? other.key) || (link.inwardIssue && link.outwardIssue)) {
    throw new Error('A link is missing its type, direction or linked issue identity.');
  }
  return JSON.stringify([String(type), direction, String(other.id ?? other.key)]);
}
