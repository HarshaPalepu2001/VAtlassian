import { contentDigest } from './content.js';
import { createSourceLinkSync } from './sourceLinkSync.js';
import { tmFail } from './messages.js';
import { endpointAllowsMirror } from './nativeLinkAuthority.js';

/** Jira types and protected native baselines are checked at the actual mutation boundary. */
export async function sourceLinkRuntime(base) {
  const [forgeModule, store, baselineStore, treeStore] = await Promise.all([
    import('@forge/api'), import('./sourceLinkStore.js'), import('../db/baselineStore.js'), import('../db/baselineTreeStore.js')
  ]);
  const api = forgeModule.default?.asApp ? forgeModule.default : forgeModule.default.default;
  const { route } = forgeModule;
  async function response(request) {
    const r = await request;
    if (!r?.ok) tmFail('SERVICE_UNAVAILABLE');
    return r.status === 204 || r.status === 201 ? null : r.json();
  }
  async function read(issueId, typeId, user = false) {
    const data = await response((user ? api.asUser() : api.asApp()).requestJira(route`/rest/api/3/issue/${issueId}?fields=issuelinks`));
    if (!Array.isArray(data?.fields?.issuelinks)) tmFail('SOURCE_LINK_PROOF_UNAVAILABLE');
    const links = data.fields.issuelinks.filter(link => String(link.type?.id) === typeId).map(link => ({
      id: link.id == null ? null : String(link.id), typeId: String(link.type.id),
      sourceIssueId: String(link.outwardIssue?.id ?? link.inwardIssue?.id ?? ''),
      direction: link.outwardIssue && !link.inwardIssue ? 'OUTWARD' : link.inwardIssue && !link.outwardIssue ? 'INWARD' : 'INVALID'
    }));
    return { complete: true, links };
  }
  const deps = { ...base, ...store,
    readSourceLinksAsApp: (issueId, typeId) => read(issueId, typeId),
    readSourceLinksAsUser: (issueId, typeId) => read(issueId, typeId, true),
    sourceLinkMutationAllowed: async ({ testIssueId, sourceIssueId, typeId, test, source }) => {
      const authority = { activeBaseline: baselineStore.activeBaseline, baselineById: baselineStore.baselineById,
        activeRootsForNode: treeStore.activeRootsForNode, readBaselineTree: treeStore.readBaselineTree };
      return await endpointAllowsMirror({ issue: test, link: { type: { id: typeId }, outwardIssue: source } }, authority)
        && await endpointAllowsMirror({ issue: source, link: { type: { id: typeId }, inwardIssue: test } }, authority);
    },
    nativeTestProofCurrent: async (issueId, actor) => {
      const full = await base.getFullIssueAsUser(issueId, actor);
      const state = await base.getSourceState(full, { viewer: actor });
      return state?.complete === true && (!state.baseline || state.governedReady === true && state.drifted === false);
    },
    createSourceLink: args => response(api.asApp().requestJira(route`/rest/api/3/issueLink`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: { id: args.typeId },
        inwardIssue: { id: args.testIssueId }, outwardIssue: { id: args.sourceIssueId } }) })),
    deleteSourceLink: linkId => response(api.asApp().requestJira(route`/rest/api/3/issueLink/${linkId}`, { method: 'DELETE' })),
    auditSourceLinkCommit: async row => {
      const { readRetestAuditEvent } = await import('./retestStore.js');
      const eventId = contentDigest({ kind: 'TM_SOURCE_LINKS_COMMITTED', versionId: row.versionId }).slice(0, 32);
      const payload = { versionId: row.versionId, digest: row.digest, typeId: row.typeId, sourceIssueIds: row.desired };
      const valid = receipt => receipt?.eventType === 'TM_SOURCE_LINKS_COMMITTED' && receipt.actorAccountId === 'system'
        && String(receipt.issueId) === row.testIssueId && contentDigest(receipt.payload) === contentDigest(payload);
      const existing = await readRetestAuditEvent(eventId);
      if (existing) { if (!valid(existing)) tmFail('CONTENT_CHANGED'); return { seq: existing.seq, entryHash: existing.entryHash }; }
      try { return await base.audit({ eventId: Buffer.from(eventId, 'hex'), eventType: 'TM_SOURCE_LINKS_COMMITTED',
        actorAccountId: 'system', issueId: Number(row.testIssueId), payload }); }
      catch (error) { const receipt = await readRetestAuditEvent(eventId); if (!valid(receipt)) throw error; return { seq: receipt.seq, entryHash: receipt.entryHash }; }
    }
  };
  const sync = createSourceLinkSync(deps);
  return { ...deps,
    verifySourceLinkProjection: (version, actor) => sync.verify(version, actor),
    syncSourceLinks: (versionId, options) => sync.sync(versionId, options),
    recordSignedSources: async version => { await base.recordSignedSources(version); await sync.enqueue(version); await sync.sync(version.versionId); },
    sourceProjectionComplete: async versionId => {
      if (!await base.sourceProjectionComplete(versionId)) return false;
      const row = await store.readSourceLinkIntent(versionId);
      return row?.state === 'COMMITTED' && Number.isSafeInteger(row.proof?.seq) && row.proof.seq > 0 && /^[a-f0-9]{64}$/.test(row.proof?.entryHash ?? '');
    }
  };
}
