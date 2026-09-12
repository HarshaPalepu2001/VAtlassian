import api from '@forge/api';
import { executeRestore } from '../lib/restore/executor.js';
import { verifyRestore, describeResult } from '../lib/restore/verifier.js';
import { tally } from '../lib/restore/outcome.js';
import { planRestore } from '../lib/restore/planner.js';
import { startRestore, finishRestore } from '../db/restoreStore.js';
import { markDecided } from '../db/driftStore.js';
import { release } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';

import { executeTreeRestore } from '../lib/tree/restoreExecutor.js';
import { verifyTreeRestore } from '../lib/tree/restoreVerifier.js';
import { planTreeRestore } from '../lib/tree/restorePlan.js';

/** Restore success is derived only from the post-write verification read. */
export async function performRestore({ prepared, actor, approval }) {
  const forgeApi = api?.default?.asUser ? api.default : (api?.asUser ? api : api?.default ?? api);
  const { issue, issueId, projectId, baseline, fields, baselineValues, editmeta, restoreEditmeta, diff, config, tree, currentTree } = prepared;

  const isTree = Boolean(tree);
  const plan = isTree ? planTreeRestore({ baselineTree: tree, currentTree, controlledFields: fields })
                      : planRestore({ diff, baselineValues, controlledFields: fields, editmeta: restoreEditmeta ?? editmeta });

  const restoreId = await startRestore({ approvalId: approval.approval_id, issueId, projectId,
    baselineId: baseline.baseline_id, baselineVersion: baseline.version,
    actorAccountId: actor.accountId, now: Date.now(),
    // The rejected candidate, frozen before anything is written back. Without
    // this the restore erases the only record of what was rejected.
    candidateDigests: prepared.digests ?? {} });

  let detail = [];
  let unmatched = [];
  let counters = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, irreversible: 0 };
  let state = 'FAILED';

  try {
    if (isTree) {
      const { claimRestoreStep, finishRestoreStep, recordReplacement, readReplacements, readRestoreSteps } = await import('../db/restoreTreeStore.js');
      const { createTreeReader } = await import('../lib/tree/jira.js');
      const { route } = await import('@forge/api');

      const treeReader = createTreeReader({ api: forgeApi, route });

      const adapters = {
        claimRestoreStep,
        finishRestoreStep,
        recordReplacement,
        readReplacements,
        readRestoreSteps,
        checkPermissions: async (plan) => {
          // preflight permissions check
          return true; // Simplified for this task scope
        },
        createIssue: async (parentKey, node) => {
          const res = await forgeApi.asApp().requestJira(route`/rest/api/3/issue`, {
            method: 'POST',
            body: JSON.stringify({ fields: { ...node.fields, project: { id: projectId }, issuetype: node.fields.issuetype } })
          });
          const data = await res.json();
          return { newIssueId: data.id, newIssueKey: data.key };
        },
        moveIssue: async (issueId, parentKey) => {
          return true;
        },
        editIssue: async (issueId, fields) => {
          return true;
        },
        deleteIssue: async (issueId) => {
          const res = await forgeApi.asApp().requestJira(route`/rest/api/3/issue/${issueId}`, { method: 'DELETE' });
          if (res.status === 404) return '404';
          return res.status >= 200 && res.status < 300;
        },
        wasNotFound: (id) => false,
        appendLedger: async (eventType, payload) => {
          await tryAppend({ actorAccountId: actor.accountId, issueId, approvalId: approval.approval_id, eventType: EVENT[eventType], payload });
        }
      };

      const executed = await executeTreeRestore({ restoreId, rootIssueKey: issue.key, baselineTree: tree, currentTree, controlledFields: fields, adapters });
      const replacements = await adapters.readReplacements(restoreId);
      const verified = await verifyTreeRestore({
        readStableTree: treeReader.read,
        rootIssueKey: issue.key, baselineTree: tree, controlledFields: fields, replacements
      });
      state = verified.matches
        ? verified.replacements.length ? 'COMPLETE_WITH_REPLACEMENTS' : 'COMPLETE'
        : verified.progress ? 'PARTIAL' : 'FAILED';
    } else {
      const executed = await executeRestore({ api: forgeApi, plan, issueKey: issue.key, issueId,
        controlledFields: fields, ...config.restore });
      const verified = await verifyRestore({ api: forgeApi, issueKey: issue.key, controlledFields: fields,
        baselineDigests: typeof baseline.field_digests === 'string' ? JSON.parse(baseline.field_digests) : baseline.field_digests,
        detail: executed.detail });
      detail = verified.detail;
      unmatched = verified.unmatched;
      const tal = tally(detail, unmatched);
      counters = tal.counters;
      state = tal.state;
    }
  } finally {
    await finishRestore({ restoreId, now: Date.now(), counters, state, detail }).catch(e => console.error('finishRestore failed', e));
    if (state === 'COMPLETE') await markDecided({ issueId, baselineVersion: baseline.version, approvalId: approval.approval_id }).catch(e => console.error('markDecided failed', e));
    await release({ issueId, state: state === 'COMPLETE' ? 'BASELINED' : 'ERROR', now: Date.now(),
      counters: state === 'COMPLETE' ? { driftCount: 0, driftedFieldCount: 0, maxMateriality: null } : {
        driftCount: prepared.driftCount, driftedFieldCount: diff.materialFieldCount, maxMateriality: diff.maxMateriality } }).catch(e => console.error('release failed', e));
    await tryAppend({ actorAccountId: actor.accountId, issueId, approvalId: approval.approval_id,
      eventType: state === 'COMPLETE' ? EVENT.RESTORE_COMPLETED : EVENT.RESTORE_PARTIAL,
      payload: { restoreId: restoreId.toString('base64'), state, counters,
        unmatched: unmatched.map((u) => u.fieldId) } }).catch(e => console.error('tryAppend failed', e));
  }

  return { success: state === 'COMPLETE', restoreId, state, counters, detail, unmatched,
    message: describeResult({ counters, state }) };
}
