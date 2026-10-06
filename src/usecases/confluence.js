import api, { route } from '@forge/api';
import { getSubjectState, setSubjectState, getWorkingCopy, setWorkingCopy, deleteWorkingCopy } from '../db/confluenceStore.js';
import { getVaultSiteBySpaceId } from '../db/vaultStore.js';
import { executeQuery } from '../lib/db.js';

/** Describes what this app does with the space the screen is rendered in. Governance
 *  policy — approver roles, required assurance, retention, vaulting — is configured
 *  per Jira project in the Jira admin console, never per Confluence space, so this
 *  reports state rather than offering settings. A vault space is provisioned by the
 *  app itself when a controlled transition first captures a baseline for a project;
 *  nobody is expected to administer it by hand. */
export async function getSpaceRole({ payload, context }) {
  const spaceId = payload?.spaceId || context?.extension?.space?.id;
  if (!spaceId) throw new Error('Space ID missing');

  const vault = await getVaultSiteBySpaceId(spaceId);
  if (!vault) return { success: true, ok: true, vault: false };
  // One vault holds every project; report how many it covers and how many of
  // them have attachment deletion locked, rather than a single project.
  const counts = await executeQuery(
    'SELECT COUNT(*) AS projects, SUM(CASE WHEN permission_locked_at IS NOT NULL THEN 1 ELSE 0 END) AS locked FROM va_vault_space WHERE project_page_id IS NOT NULL',
    []
  );
  const row = counts?.result ? counts.data?.[0] ?? {} : {};
  return {
    success: true,
    ok: true,
    vault: true,
    spaceKey: vault.space_key,
    projectCount: Number(row.projects ?? 0),
    lockedProjectCount: Number(row.locked ?? 0)
  };
}

export async function getPageStatus({ payload, context }) {
  const pageId = payload?.pageId || context?.extension?.content?.id;
  if (!pageId) return { success: true, ok: true, status: 'UNPROTECTED' };

  const state = await getSubjectState(pageId);
  if (!state) return { success: true, ok: true, status: 'UNPROTECTED' };
  
  const wc = await getWorkingCopy(pageId);
  if (wc) {
    return { success: true, ok: true, status: 'WORKING_COPY' };
  }
  
  return { success: true, ok: true, status: state.state }; // e.g. PROTECTED, DRIFTED
}

export async function protectPage({ payload, context }) {
  const pageId = payload?.pageId || context?.extension?.content?.id;
  if (!pageId) throw new Error('Page ID missing');
  
  const { ConfluenceAdapter } = await import('../lib/confluenceAdapter.js');
  const { GovernedObjectRef } = await import('../lib/governanceCore.js');
  const { throwing } = await import('../db/store.js');
  const { objectStore } = await import('../db/objectStore.js');
  const { createHash, randomUUID, randomBytes } = await import('crypto');
  
  const adapter = new ConfluenceAdapter();
  const ref = new GovernedObjectRef('confluence', context?.accountId, context?.workspaceId, 'page', pageId, null);
  
  const snapshot = await adapter.stableCapture(ref);

  // The restriction first, as the viewer. A page they may not restrict is not
  // protected, whatever else could be recorded about it — and recording it as
  // PROTECTED anyway would tell everyone a page is locked that anyone can edit.
  if (!await adapter.lock(ref)) {
    return { success: false, ok: false, error: 'The page could not be restricted. You need permission to change who can edit it.' };
  }

  const snapshotJson = JSON.stringify(snapshot);
  const hash = createHash('sha256').update(snapshotJson).digest('hex');
  await objectStore.set(hash, Buffer.from(snapshotJson, 'utf8'));

  const baselineId = randomUUID();
  await throwing('DELETE FROM va_governance_baseline WHERE subject_id = ?', [pageId]);
  await throwing('INSERT INTO va_governance_baseline (baseline_id, subject_id, content_hash) VALUES (?, ?, ?)', [baselineId, pageId, hash]);

  const approvalId = randomUUID();
  await throwing('DELETE FROM va_governance_approval WHERE subject_id = ?', [pageId]);
  await throwing('INSERT INTO va_governance_approval (approval_id, subject_id, state) VALUES (?, ?, ?)', [approvalId, pageId, 'CONSUMED']);
  
  const propRes = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}/properties`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'vatlassian_evidence', value: { hash, status: 'PROTECTED', approval: approvalId } })
  });
  if (!propRes.ok) {
     await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}/properties/vatlassian_evidence`, {
       method: 'PUT', headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ value: { hash, status: 'PROTECTED', approval: approvalId } })
     });
  }
  
  const { auditStore } = await import('../db/store.js');
  const { append, EVENT } = await import('../lib/ledger.js');
  try {
     await append(auditStore, { eventId: randomBytes(16), actorAccountId: context?.accountId || 'system', eventType: EVENT.BASELINE_CAPTURED, payload: { hash, pageId }});
  } catch(e) {}
  
  const { setSubjectState } = await import('../db/confluenceStore.js');
  await setSubjectState(pageId, 'confluence', 'page', 'PROTECTED');
  return { success: true, ok: true };
}

export async function checkOut({ payload, context }) {
  const pageId = payload?.pageId || context?.extension?.content?.id;
  if (!pageId) throw new Error('Page ID missing');
  
  const { getSubjectState, setSubjectState, setWorkingCopy } = await import('../db/confluenceStore.js');
  const state = await getSubjectState(pageId);
  if (state?.state !== 'PROTECTED') throw new Error('Page is not PROTECTED');
  
  const { ConfluenceAdapter } = await import('../lib/confluenceAdapter.js');
  const { GovernedObjectRef } = await import('../lib/governanceCore.js');
  
  const adapter = new ConfluenceAdapter();
  const ref = new GovernedObjectRef('confluence', context?.accountId, context?.workspaceId, 'page', pageId, null);
  const wcRef = await adapter.createWorkingCopy(ref);
  
  await setWorkingCopy(wcRef.contentId, pageId, Date.now());
  await setSubjectState(pageId, 'confluence', 'page', 'WORKING_COPY');
  
  return { success: true, ok: true, copyId: wcRef.contentId };
}
