import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VERSION_CHAIN, chainDigest } from '../src/testmgmt/chain.js';
import { contentDigest } from '../src/testmgmt/content.js';
import { planningWorld } from './helpers/tm-planning-world.js';

const module = await import('../src/testmgmt/planning.js').catch(() => ({}));
const usecase = await import('../src/usecases/testPlanning.js').catch(() => ({}));
const normalise = (...args) => { assert.equal(typeof module.normaliseDataset, 'function', 'dataset normalization exists'); return module.normaliseDataset(...args); };
const expand = (...args) => { assert.equal(typeof module.expandDatasetSteps, 'function', 'bounded expansion exists'); return module.expandDatasetSteps(...args); };
const actor = { accountId: 'author' };
const signer = { accountId: 'approver' };
const rowDataset = { parameters: [{ name: 'voltage', type: 'TEXT' }], rows: [{ id: 'low', values: { voltage: '12 V' } }, { id: 'high', values: { voltage: '24 V' } }] };
const steps = [{ id: 's1', action: 'Apply {{voltage}}', data: '{{voltage}}', expected: 'Works at {{voltage}}' }];
const create = (w) => { assert.equal(typeof usecase.createTestPlanning, 'function', 'planning usecase exists'); return usecase.createTestPlanning(w.deps); };

test('dataset rejects duplicate, reserved, unknown and missing parameters and iteration ids', () => {
  assert.equal(normalise({ ...rowDataset, parameters: [...rowDataset.parameters, ...rowDataset.parameters] }).error, 'PARAMETER_INVALID');
  assert.equal(normalise({ parameters: [{ name: '__proto__', type: 'TEXT' }], rows: [] }).error, 'PARAMETER_INVALID');
  assert.equal(normalise({ ...rowDataset, rows: [{ id: 'one', values: { other: 'x' } }] }).error, 'ROW_VALUES_INVALID');
  assert.equal(normalise({ ...rowDataset, rows: [{ id: 'same', values: { voltage: 'x' } }, { id: 'same', values: { voltage: 'y' } }] }).error, 'ITERATION_ID_INVALID');
});

test('dataset expands in explicit row order with literal nonrecursive substitution and stable digest', () => {
  const content = { dataset: rowDataset, steps };
  const a = expand(content); const b = expand(structuredClone(content));
  assert.equal(a.error, undefined);
  assert.deepEqual(a, b);
  assert.deepEqual(a.iterations.map(i => i.id), ['low', 'high']);
  assert.deepEqual(a.steps.map(s => [s.id, s.sourceStepId, s.iterationId, s.action]), [
    ['low__s1', 's1', 'low', 'Apply 12 V'], ['high__s1', 's1', 'high', 'Apply 24 V']]);
  assert.equal(a.digest.length, 64);
  assert.deepEqual(content, { dataset: rowDataset, steps }, 'input is unchanged');
  const literal = expand({ steps, dataset: { ...rowDataset, rows: [{ id: 'raw', values: { voltage: '$& {{other}}' } }] } });
  assert.equal(literal.steps[0].data, '$& {{other}}');
  assert.equal(expand({ steps: [{ ...steps[0], action: '{{missing}}' }], dataset: rowDataset }).error, 'PARAMETER_UNDEFINED');
  const literalWithoutDataset = { id: 's1', action: 'Enter {{username}}', data: '{{literal}}', expected: 'Preserve braces' };
  assert.deepEqual(expand({ steps: [literalWithoutDataset] }).steps.map(({ id, action, data, expected }) => ({ id, action, data, expected })), [literalWithoutDataset]);
});

test('bounded combinatorial expansion and substituted text reject runaway work', () => {
  const parameters = ['a', 'b', 'c'].map(name => ({ name, type: 'LIST', values: Array.from({ length: 5 }, (_, i) => String(i)) }));
  assert.equal(normalise({ mode: 'COMBINATORIAL', parameters, rows: [] }).error, 'TOO_MANY_ITERATIONS');
  const small = expand({ steps, dataset: { mode: 'COMBINATORIAL', parameters: [{ name: 'voltage', type: 'LIST', values: ['12', '24'] }] } });
  assert.deepEqual(small.iterations.map(i => [i.id, i.values.voltage]), [['c001', '12'], ['c002', '24']]);
  assert.equal(expand({ steps: [{ ...steps[0], action: '{{voltage}}'.repeat(2) }], dataset: { ...rowDataset, rows: [{ id: 'long', values: { voltage: 'x'.repeat(4000) } }] } }).error, 'STEP_TOO_LONG');
  assert.equal(expand({ steps: Array.from({ length: 201 }, (_, i) => ({ ...steps[0], id: `s${i}` })) }).error, 'TOO_MANY_STEPS');
  assert.deepEqual(expand({ steps: [{ id: 's1', action: 'Read', data: '', expected: 'OK' }] }).steps.map(s => s.id), ['s1']);
});

async function published(w, issueKey = 'VAT-21', draft = {}) {
  const uc = create(w);
  const saved = await uc.saveDraft({ issueKey, expectedRevision: 0, draft: { objective: 'Release checks', members: [{ testIssueId: '11', required: true }],
    environment: 'Bench', configurations: [{ id: 'cfg-a', name: 'ECU A' }], releaseId: '900', ...draft } }, actor);
  const model = await uc.publish({ issueKey, expectedRevision: saved.draft.revision }, actor);
  return { uc, model, revision: model.revisions[0] };
}

test('planning enforces mapped Jira identity, edit access and optimistic draft revision', async () => {
  const w = planningWorld(); const uc = create(w);
  w.denied.add('21');
  await assert.rejects(uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: {} }, actor), { reason: 'NO_EDIT_PERMISSION' });
  w.denied.clear();
  await assert.rejects(uc.view('VAT-11', actor), { reason: 'NOT_A_COLLECTION' });
  const saved = await uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: {} }, actor);
  assert.equal(saved.draft.revision, 1);
  await assert.rejects(uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: {} }, actor), { reason: 'STALE' });
  await assert.rejects(uc.publish({ issueKey: 'VAT-21', expectedRevision: 0 }, actor), { reason: 'STALE' });
});

test('hidden or cross-project members are rejected before saving and never disclosed by view', async () => {
  const w = planningWorld(); const uc = create(w);
  w.hidden.add('11');
  await assert.rejects(uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { members: [{ testIssueId: '11' }] } }, actor), { reason: 'NOT_FOUND' });
  assert.equal(w.drafts.size, 0);
  w.hidden.clear(); w.issues.get('11').fields.project.id = '200';
  await assert.rejects(uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { members: [{ testIssueId: '11' }] } }, actor), { reason: 'MEMBER_INVALID' });
  w.issues.get('11').fields.project.id = '100';
  await uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { members: [{ testIssueId: '11' }] } }, actor);
  w.hidden.add('11');
  await assert.rejects(uc.view('VAT-21', actor), { reason: 'NOT_FOUND' });
});

test('signed plan selection freezes ordered versions, release/configuration and precondition snapshot', async () => {
  const w = planningWorld();
  const pre = await published(w, 'VAT-23', { text: 'Calibrated supply', members: [], configurations: [], releaseId: null });
  let preSigned = await pre.uc.sign({ revisionId: pre.revision.revisionId, contentHash: pre.revision.digest, code: '123456' }, signer);
  assert.equal(preSigned.revisions[0].state, 'SIGNED');
  const { uc, revision } = await published(w, 'VAT-21', { preconditions: [{ issueId: '23', revisionId: pre.revision.revisionId }] });
  assert.equal(revision.content.members[0].versionId, w.version.versionId);
  await assert.rejects(uc.selectRuns({ revisionId: revision.revisionId, contentHash: revision.digest }, actor), { reason: 'PLAN_NOT_SIGNED' });
  await uc.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, signer);
  w.version = { ...w.version, versionId: 'b'.repeat(32), versionNo: 2 };
  const selected = await uc.selectRuns({ revisionId: revision.revisionId, contentHash: revision.digest }, actor);
  assert.equal(selected.runs[0].testVersionId, 'a'.repeat(32));
  assert.deepEqual(selected.runs[0].release, { id: '900', name: 'Release 1' });
  assert.equal(selected.runs[0].configuration, 'ECU A');
  assert.equal(selected.runs[0].planRevisionId, revision.revisionId);
  assert.equal(selected.runs[0].preconditions[0].text, 'Calibrated supply');
  assert.equal(contentDigest(revision.content), revision.digest);
  preSigned = null;
});

test('a terminal collection cannot select runs from unaudited or wrong-role signatures', async () => {
  const w = planningWorld(); const { uc, revision } = await published(w);
  await uc.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, signer);
  w.signatures[0].auditSeq = null;
  await assert.rejects(uc.selectRuns({ revisionId: revision.revisionId, contentHash: revision.digest }, actor), { reason: 'CONTENT_CHANGED' });
});

test('uncertain publication and signature writes cannot make a runnable plan and can recover', async () => {
  const w = planningWorld(); const { uc, revision } = await published(w);
  w.failState = true;
  await assert.rejects(uc.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, signer), { reason: 'SIGNATURE_STATE_PENDING' });
  await assert.rejects(uc.selectRuns({ revisionId: revision.revisionId, contentHash: revision.digest }, actor), { reason: 'PLAN_NOT_SIGNED' });
  w.failState = false;
  const recovered = await uc.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, signer);
  assert.equal(recovered.revisions[0].state, 'SIGNED');
  assert.equal(w.signatures.length, 1);
  w.hidden.add('11');
  await assert.rejects(uc.selectRuns({ revisionId: revision.revisionId, contentHash: revision.digest }, actor), { reason: 'NOT_FOUND' });
});

test('incomplete revision lists and unsigned or tampered versions fail closed', async () => {
  const w = planningWorld(); const uc = create(w);
  w.incomplete = true;
  await assert.rejects(uc.view('VAT-21', actor), { reason: 'RECORDS_INCOMPLETE' });
  w.incomplete = false; w.version.state = 'PUBLISHED';
  await assert.rejects(published(w), { reason: 'NO_SIGNED_VERSION' });
  w.version.state = 'SIGNED'; w.version.digest = 'f'.repeat(64);
  await assert.rejects(uc.publish({ issueKey: 'VAT-21', expectedRevision: 1 }, actor), { reason: 'CONTENT_CHANGED' });
});

test('expanded dataset snapshots fit bounded run and result records', () => {
  const dataset = { parameters: [{ name: 'n', type: 'TEXT' }], rows: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, values: { n: 'x' } })) };
  const steps = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, action: '{{n}}', data: '', expected: 'OK' }));
  assert.equal(expand({ dataset, steps }).error, 'TOO_MANY_EXPANDED_STEPS');
  const large = { ...dataset, rows: dataset.rows.map(row => ({ ...row, values: { n: 'x'.repeat(3000) } })) };
  assert.equal(expand({ dataset: large, steps: steps.slice(0, 1) }).error, 'DATASET_TOO_LARGE');
});

test('people resolve Jira keys and latest signed preconditions without typing internal identifiers', async () => {
  const w = planningWorld(); const uc = create(w);
  assert.equal(typeof uc.lookup, 'function');
  const found = await uc.lookup({ issueKey: 'VAT-11', collectionKey: 'VAT-21', kind: 'TEST' }, actor);
  assert.equal(found.key, 'VAT-11'); assert.equal(found.latestSigned.versionNo, 1);
  const pre = await published(w, 'VAT-23', { text: 'Supply ready', members: [], releaseId: null, configurations: [] });
  await pre.uc.sign({ revisionId: pre.revision.revisionId, contentHash: pre.revision.digest, code: '123456' }, signer);
  const saved = await uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { members: [{ testIssueKey: 'VAT-11' }],
    preconditions: [{ issueKey: 'VAT-23' }], environment: 'Bench', configurations: [{ id: 'a', name: 'ECU A' }], releaseId: '900' } }, actor);
  assert.equal(saved.draft.members[0].testIssueId, '11'); assert.equal(saved.draft.members[0].testIssueKey, 'VAT-11');
  assert.equal(saved.draft.preconditions[0].issueKey, 'VAT-23');
  const pub = await uc.publish({ issueKey: 'VAT-21', expectedRevision: saved.draft.revision }, actor);
  assert.equal(pub.revisions[0].content.preconditions[0].revisionId, pre.revision.revisionId);
  w.hidden.add('11');
  await assert.rejects(uc.lookup({ issueKey: 'VAT-11', collectionKey: 'VAT-21', kind: 'TEST' }, actor), { reason: 'NOT_FOUND' });
});

test('run planning validation marks changed drafts stale without rewriting the signed snapshot', async () => {
  const w = planningWorld(); const { uc, revision } = await published(w);
  await uc.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, signer);
  const selection = await uc.selectRuns({ revisionId: revision.revisionId, contentHash: revision.digest }, actor);
  const run = { planningSnapshot: { plan: selection.plan, preconditions: [] } };
  assert.equal(typeof uc.validateRunPlanningSnapshot, 'function');
  assert.deepEqual(await uc.validateRunPlanningSnapshot(run, actor), { ok: true, current: true, reason: null });
  await uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 1, draft: { ...w.drafts.get('21').content, objective: 'Changed plan' } }, actor);
  assert.deepEqual(await uc.validateRunPlanningSnapshot(run, actor), { ok: true, current: false, reason: 'PLAN_CHANGED' });
  assert.equal(w.revisions.get(revision.revisionId).digest, revision.digest);
  w.hidden.add('11');
  await assert.rejects(uc.validateRunPlanningSnapshot(run, actor), { reason: 'NOT_FOUND' });
});

test('plan environment limits match persisted execution fields and rejected signing stays ineligible', async () => {
  const w = planningWorld(); const uc = create(w);
  await assert.rejects(uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { environment: 'x'.repeat(256) } }, actor), { reason: 'INVALID_INPUT' });
  const { revision } = await published(w);
  w.deps.isEligibleFor = async () => false;
  await assert.rejects(uc.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, signer), { reason: 'NOT_ELIGIBLE' });
  assert.equal(w.signatures.length, 0);
});

test('an in-flight publication audit blocks concurrent sign and an audit failure leaves a recoverable unpublished revision', async () => {
  const w = planningWorld(); const uc = create(w);
  const saved = await uc.saveDraft({ issueKey: 'VAT-21', expectedRevision: 0, draft: { members: [{ testIssueId: '11' }], environment: 'Bench', releaseId: '900', configurations: [{ id: 'a', name: 'ECU A' }] } }, actor);
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const original = w.deps.audit; w.deps.audit = async () => blocked;
  const publishing = uc.publish({ issueKey: 'VAT-21', expectedRevision: saved.draft.revision }, actor);
  await new Promise(resolve => setImmediate(resolve));
  const pending = [...w.revisions.values()][0]; assert.equal(pending.state, 'PUBLISHING');
  await assert.rejects(uc.sign({ revisionId: pending.revisionId, contentHash: pending.digest, code: '123456' }, signer), { reason: 'COLLECTION_NOT_PUBLISHED' });
  assert.equal(w.signatures.length, 0); release(); await publishing;
  assert.equal(w.revisions.get(pending.revisionId).state, 'PUBLISHED');
  w.deps.audit = original;
  const w2 = planningWorld(); const uc2 = create(w2);
  await uc2.saveDraft({ issueKey: 'VAT-23', expectedRevision: 0, draft: { text: 'Ready' } }, actor);
  w2.ledgerDown = true;
  await assert.rejects(uc2.publish({ issueKey: 'VAT-23', expectedRevision: 1 }, actor), { reason: 'LEDGER_UNAVAILABLE' });
  assert.equal([...w2.revisions.values()][0].state, 'PUBLISHING');
  w2.ledgerDown = false;
  const repaired = await uc2.publish({ issueKey: 'VAT-23', expectedRevision: 1 }, actor);
  assert.equal(repaired.revisions.length, 1); assert.equal(repaired.revisions[0].state, 'PUBLISHED');
});

test('pending audit signature promotion blocks the chain and offers recovery', async () => {
  const w = planningWorld(); const { uc, revision } = await published(w);
  w.deps.hasPendingSignatures = async () => true;
  const view = await uc.view('VAT-21', actor);
  assert.equal(view.revisions[0].canSign, false); assert.equal(view.revisions[0].canRecover, true);
  await assert.rejects(uc.sign({ revisionId: revision.revisionId, contentHash: revision.digest, code: '123456' }, signer), { reason: 'SIGNATURE_PENDING' });
  assert.equal(w.signatures.length, 0);
});
