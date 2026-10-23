import { DEFAULT_VERSION_CHAIN, chainDigest } from '../../src/testmgmt/chain.js';
import { contentDigest } from '../../src/testmgmt/content.js';

export function planningWorld() {
  let seq = 0;
  const project = { projectId: '100', enabled: true, testTypeId: '1', planTypeId: '4', setTypeId: '5', preconditionTypeId: '6',
    versionChain: DEFAULT_VERSION_CHAIN };
  const issue = (id, type) => ({ id, key: `VAT-${id}`, fields: { project: { id: '100' }, issuetype: { id: type },
    summary: `Summary ${id}`, parent: { id: '10', key: 'VAT-10' } } });
  const content = { kind: 'TEST_VERSION', testIssueId: '11', projectId: '100', versionNo: 1, steps: [{ id: 's1', action: 'Read', data: '', expected: 'OK' }] };
  const version = { versionId: 'a'.repeat(32), testIssueId: '11', projectId: '100', versionNo: 1, state: 'SIGNED', content,
    digest: contentDigest(content), chain: DEFAULT_VERSION_CHAIN, chainDigest: chainDigest(DEFAULT_VERSION_CHAIN) };
  const original = structuredClone(version);
  const w = { issues: new Map([['11', issue('11', '1')], ['21', issue('21', '4')], ['22', issue('22', '5')], ['23', issue('23', '6')]]),
    drafts: new Map(), revisions: new Map(), signatures: [], audit: [], hidden: new Set(), denied: new Set(), version,
    incomplete: false, failState: false, ledgerDown: false };
  const readVersion = async (id) => structuredClone(id === original.versionId ? (w.version.versionId === id ? w.version : original) : w.version.versionId === id ? w.version : null);
  const testSignature = () => ({ state: 'ACTIVE', subject_kind: 'TEST_VERSION', subjectId: original.versionId,
    step_index: 0, account_id: 'approver', decision: 'SIGN', contentHash: original.digest,
    role: DEFAULT_VERSION_CHAIN.steps[0].role, auditSeq: 1, auditHash: 'f'.repeat(64) });
  w.deps = {
    now: () => 1_800_000_000_000 + seq, newHexId: () => (++seq).toString(16).padStart(32, '0'),
    readIssueAsUser: async (id) => { const i = [...w.issues.values()].find(i => i.id === String(id) || i.key === String(id));
      if (!i || w.hidden.has(i.id)) throw Object.assign(new Error('hidden'), { reason: 'NOT_FOUND' }); return structuredClone(i); },
    readProject: async () => project,
    hasIssuePermission: async (id) => !w.denied.has(String(id)),
    projectVersions: async () => [{ id: '900', name: 'Release 1' }],
    latestSignedVersion: async () => structuredClone(w.version), readVersion,
    readCollectionDraft: async (id) => structuredClone(w.drafts.get(String(id)) ?? null),
    saveCollectionDraft: async ({ issueId, projectId, role, content, expectedRevision, actor, editors }) => {
      const previous = w.drafts.get(String(issueId)); if ((previous?.revision ?? 0) !== expectedRevision) return null;
      const revision = expectedRevision + 1; w.drafts.set(String(issueId), { issueId: String(issueId), projectId, role, content: structuredClone(content), revision,
        updatedBy: actor, editors: structuredClone(editors ?? []) }); return revision;
    },
    listCollectionRevisions: async (id) => ({ items: [...w.revisions.values()].filter(r => r.issueId === String(id)).sort((a,b) => b.revisionNo-a.revisionNo).map(r => structuredClone(r)), complete: !w.incomplete }),
    readCollectionRevision: async (id) => structuredClone(w.revisions.get(id) ?? null),
    insertCollectionRevision: async (r) => { if ([...w.revisions.values()].some(x => x.issueId === String(r.issueId) && x.revisionNo === r.revisionNo)) return false;
      w.revisions.set(r.revisionId, { ...structuredClone(r), issueId: String(r.issueId), state: 'PUBLISHING' }); return true; },
    setCollectionRevisionState: async (id, { from, to }) => { if (w.failState) return false; const r = w.revisions.get(id); if (r?.state !== from) return false; r.state = to; return true; },
    isEligibleFor: async () => true, myself: async () => ({ displayName: 'Author' }),
    listSignatures: async (kind, id) => kind === 'TEST_VERSION' ? [testSignature()] : w.signatures.filter(s => s.subject_kind === kind && s.subjectId === id),
    recordSignature: async (s) => { if (w.ledgerDown) return { ok: false, reason: 'LEDGER_UNAVAILABLE' };
      if (s.code !== '123456') return { ok: false, reason: 'CODE_INVALID' };
      w.signatures.push({ state: 'ACTIVE', subject_kind: s.kind, subjectId: s.subjectId, step_index: s.stepIndex, account_id: s.signer.accountId,
        role: s.step.role, auditSeq: w.signatures.length + 1, auditHash: 'f'.repeat(64), decision: s.decision, contentHash: s.contentHash }); return { ok: true }; },
    audit: async (event) => { if (w.ledgerDown) throw new Error('ledger down'); w.audit.push(event); }
  };
  return w;
}
