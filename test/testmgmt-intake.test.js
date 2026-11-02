import { candidateWorld } from './helpers/tm-candidates.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestIntake } from '../src/usecases/testIntake.js';
import { assertIntakeReady, INTAKE_LIMITS } from '../src/testmgmt/intake.js';

const ids = { run: 'a'.repeat(32), other: 'b'.repeat(32) };
function fixture() {
  let seq = 1, clock = 1000;
  const tokens = new Map(), grants = new Map(), receipts = new Map(), runs = new Map(), audits = new Map();
  const issue = { id: '12', key: 'T-12', fields: { project: { id: '100' }, issuetype: { id: '9' }, status: { statusCategory: { key: 'new' } } } };
  const project = { projectId: '100', enabled: true, executionTypeId: '9', runChain: { steps: [{ role: 'TESTER' }] } };
  const run = id => ({ runId: id, projectId: '100', executionIssueId: '12', testIssueId: '11', testVersionId: 'c'.repeat(32), evidenceSchema: 2, attemptSequence: seq++, classification: { level: 'SYSTEM', method: 'AUTOMATED' }, state: 'IN_PROGRESS', revision: 1, steps: [{ id: 's1', status: 'NOT_RUN', evidence: [] }], resolvedSteps: [{ id: 's1' }], iterations: [{ id: 'default', stepIds: ['s1'] }] });
  runs.set(ids.run, run(ids.run)); runs.set(ids.other, run(ids.other));
  const deps = {
    installationId: 'install-1', now: () => clock, newHexId: () => (seq++).toString(16).padStart(32, '0'),
    readIssueAsUser: async () => issue, testManagementRole: async () => ({ role: 'EXECUTION', project }), readProject: async () => project,
    hasIssuePermission: async () => true, isEligibleFor: async () => true, readIntakeExecution: async () => issue,
    readRun: async id => structuredClone(runs.get(id) ?? null), readVersion: async () => null,
    insertIntakeToken: async t => { tokens.set(t.tokenId, structuredClone(t)); return true; }, readIntakeToken: async id => structuredClone(tokens.get(id)),
    listIntakeTokens: async () => [...tokens.values()], revokeIntakeToken: async (id, now) => { tokens.get(id).revokedAt = now; },
    insertIntakeGrant: async g => { grants.set(g.grantId, structuredClone(g)); return true; }, readIntakeGrant: async id => structuredClone(grants.get(id)),
    listIntakeGrants: async () => [...grants.values()], revokeIntakeGrant: async (id, now) => { grants.get(id).revokedAt = now; },
    findIntakeReceipt: async key => structuredClone([...receipts.values()].find(r => r.idempotencyHash === key)),
    readIntakeReceipt: async id => structuredClone(receipts.get(id)), listIntakeReceipts: async () => [...receipts.values()],
    insertIntakeReceipt: async r => { if ([...receipts.values()].some(x => x.idempotencyHash === r.idempotencyHash)) return false; receipts.set(r.receiptId, structuredClone(r)); return true; },
    readIntakeForRun: async runId => [...receipts.values()].filter(r => r.mappings.some(m => m.runId === runId)),
    reserveIntakeRun: async ({ runId, receiptId, expectedRevision }) => { const r = runs.get(runId); if (r.intakeReceiptId === receiptId) return true; if (r.revision !== expectedRevision || r.intakeReceiptId || r.state !== 'IN_PROGRESS') return false; r.intakeReceiptId = receiptId; return true; },
    applyIntakeRun: async ({ runId, receiptId, steps, result, reportedBuild, provenance }) => { const r = runs.get(runId); if (r.intakeApplied) return true; if (r.intakeReceiptId !== receiptId) return false; Object.assign(r, { steps, result, reportedBuild, provenance, intakeApplied: true, revision: r.revision + 1 }); return true; },
    markIntakeProgress: async (receiptId, runId) => { const r = receipts.get(receiptId); r.progress = [...new Set([...r.progress, runId])]; },
    completeIntakeReceipt: async (receiptId, proof) => { Object.assign(receipts.get(receiptId), { status: 'APPLIED', auditProof: proof }); return true; },
    audit: async event => { audits.set(event.eventId?.toString('hex') ?? String(audits.size), event); return { seq: audits.size, entryHash: 'f'.repeat(64) }; },
    confirmIntakeAudit: async receipt => { const e = audits.get(receipt.auditEventId); return e && e.payload.payloadDigest === receipt.payloadDigest ? { seq: 1, entryHash: 'f'.repeat(64) } : null; },
    enqueueIntake: async () => {}
  };
  Object.assign(deps, candidateWorld(deps));
  const actor = { accountId: 'human' }, uc = createTestIntake(deps);
  async function prepare(runIds = [ids.run]) {
    const token = await uc.createToken({ issueKey: 'T-12', label: 'CI', expiresAt: 100000 }, actor);
    const grant = await uc.grant({ issueKey: 'T-12', tokenId: token.tokenId, runIds, expiresAt: 90000 }, actor);
    const body = JSON.stringify({ idempotencyKey: 'build-12345', executionIssueId: '12', grantId: grant.grantId, reportedBuild: { id: 'sha123', pipelineUrl: 'https://ci.invalid/123' }, results: runIds.map(runId => ({ runId, expectedRevision: 1, steps: [{ stepId: 's1', iterationId: 'default', status: 'PASSED', actual: 'OK' }] })) });
    return { token, grant, body, submit: () => uc.receive({ authorization: `Bearer ${token.token}`, body }) };
  }
  return { uc, deps, actor, prepare, tokens, grants, receipts, runs, audits, tick: n => { clock = n; } };
}

test('CI results preserve original bytes and machine executor, with receipt-wide readiness', async () => {
  const f = fixture(), p = await f.prepare(); const receipt = await p.submit();
  assert.equal(f.receipts.get(receipt.receiptId).originalPayload, p.body);
  await assert.rejects(assertIntakeReady(f.runs.get(ids.run), f.deps), { reason: 'INTAKE_PENDING' });
  await f.uc.process({ receiptId: receipt.receiptId });
  const run = f.runs.get(ids.run);
  assert.equal(run.result, 'PASSED'); assert.equal(run.provenance.kind, 'MACHINE');
  assert.equal(run.steps[0].recordedBy, `ci:${p.token.tokenId}`);
  assert.equal(f.receipts.get(receipt.receiptId).status, 'APPLIED');
  assert.equal(await assertIntakeReady(run, f.deps), true);
  assert.equal(f.tokens.get(p.token.tokenId).secretHash.includes(p.token.token), false);
});

test('identical retries reuse receipt and conflicting payloads fail', async () => {
  const f = fixture(), p = await f.prepare(), first = await p.submit();
  assert.equal((await p.submit()).receiptId, first.receiptId); assert.equal(f.receipts.size, 1);
  const body = JSON.parse(p.body); body.results[0].steps[0].actual = 'different';
  await assert.rejects(f.uc.receive({ authorization: `Bearer ${p.token.token}`, body: JSON.stringify(body) }), { reason: 'IDEMPOTENCY_CONFLICT' });
});

test('revocation after queueing blocks every queued write and expiry rejects intake', async () => {
  const f = fixture(), p = await f.prepare(), receipt = await p.submit();
  await f.uc.revokeGrant({ issueKey: 'T-12', grantId: p.grant.grantId }, f.actor);
  await assert.rejects(f.uc.process({ receiptId: receipt.receiptId }), { reason: 'INTAKE_UNAUTHORIZED' });
  assert.equal(f.runs.get(ids.run).intakeReceiptId, undefined);
  f.tick(100001); await assert.rejects(p.submit(), { reason: 'INTAKE_UNAUTHORIZED' });
});

test('partial writes remain unsignable and recover without duplicating or losing originals', async () => {
  const f = fixture(), p = await f.prepare([ids.run, ids.other]), receipt = await p.submit();
  const original = f.deps.applyIntakeRun; let fail = true;
  f.deps.applyIntakeRun = async x => { if (x.runId === ids.other && fail) throw new Error('outage'); return original(x); };
  await assert.rejects(f.uc.process({ receiptId: receipt.receiptId }), /outage/);
  for (const run of f.runs.values()) await assert.rejects(assertIntakeReady(run, f.deps), { reason: 'INTAKE_PENDING' });
  fail = false; await f.uc.process({ receiptId: receipt.receiptId });
  assert.equal(f.runs.get(ids.run).revision, 2); assert.equal(f.runs.get(ids.other).revision, 2);
  assert.equal(f.receipts.get(receipt.receiptId).progress.length, 2);
});

test('audit failure preserves pending receipt and recovery requires confirmed matching audit', async () => {
  const f = fixture(), p = await f.prepare(), receipt = await p.submit();
  const audit = f.deps.audit; f.deps.audit = async () => { throw new Error('audit outage'); };
  await assert.rejects(f.uc.process({ receiptId: receipt.receiptId }), /audit outage/);
  await assert.rejects(assertIntakeReady(f.runs.get(ids.run), f.deps), { reason: 'INTAKE_PENDING' });
  f.deps.audit = audit; await f.uc.process({ receiptId: receipt.receiptId });
  assert.equal(await assertIntakeReady(f.runs.get(ids.run), f.deps), true);
  f.deps.confirmIntakeAudit = async () => null;
  await assert.rejects(assertIntakeReady(f.runs.get(ids.run), f.deps), { reason: 'INTAKE_PENDING' });
});

test('exact mapping rejects missing, duplicated, foreign and wrong-iteration results before write', async () => {
  for (const mutation of [b => { b.results[0].steps = []; }, b => { b.results.push(b.results[0]); }, b => { b.results[0].runId = ids.other; }, b => { b.results[0].steps[0].iterationId = 'other'; }]) {
    const f = fixture(), p = await f.prepare(), body = JSON.parse(p.body); mutation(body);
    await assert.rejects(f.uc.receive({ authorization: `Bearer ${p.token.token}`, body: JSON.stringify(body) }));
    assert.equal(f.receipts.size, 0);
  }
});

test('bounded input and authenticated grants fail closed without writes or network fetching', async () => {
  const f = fixture(), p = await f.prepare();
  await assert.rejects(f.uc.receive({ authorization: `Bearer ${p.token.token}`, body: ' '.repeat(INTAKE_LIMITS.bytes + 1) }), { reason: 'INTAKE_TOO_LARGE' });
  f.deps.isEligibleFor = async () => false;
  await assert.rejects(f.uc.grant({ issueKey: 'T-12', tokenId: p.token.tokenId, runIds: [ids.run], expiresAt: 90000 }, f.actor), { reason: 'NOT_ELIGIBLE' });
});

test('tampered stored provenance, build identity and original mappings cannot be applied or accepted as ready', async () => {
  for (const mutate of [r => { r.provenance.tokenId = '9'.repeat(32); }, r => { r.reportedBuild.id = 'different'; }, r => { r.mappings = []; }]) {
    const f = fixture(), p = await f.prepare(), response = await p.submit(); mutate(f.receipts.get(response.receiptId));
    await assert.rejects(f.uc.process({ receiptId: response.receiptId }), { reason: 'INTAKE_RECORD_INVALID' });
    assert.equal(f.runs.get(ids.run).result, undefined);
  }
});

test('missing machine receipt and corrupt authorization timestamps fail closed', async () => {
  const f = fixture(), p = await f.prepare(); f.tokens.get(p.token.tokenId).expiresAt = NaN;
  await assert.rejects(p.submit(), { reason: 'INTAKE_UNAUTHORIZED' });
  await assert.rejects(assertIntakeReady({ ...f.runs.get(ids.run), provenance: { kind: 'MACHINE' } }, f.deps), { reason: 'INTAKE_PENDING' });
});

test('a user who cannot read a mapped test cannot open original receipt results', async () => {
  const f = fixture(), p = await f.prepare(), response = await p.submit();
  f.deps.readIssueAsUser = async key => { if (key === '11') throw Object.assign(new Error('hidden'), { reason: 'NOT_FOUND' }); return { id: '12', fields: { project: { id: '100' }, issuetype: { id: '9' } } }; };
  await assert.rejects(f.uc.receipt({ issueKey: 'T-12', receiptId: response.receiptId }, f.actor), { reason: 'NOT_FOUND' });
});

test('CI cannot submit a second candidate to another prepared run in the same execution', async () => {
  const f = fixture(), p = await f.prepare([ids.run]), first = await p.submit();
  await f.uc.process({ receiptId: first.receiptId });
  const other = await f.prepare([ids.other]), payload = JSON.parse(other.body);
  payload.reportedBuild.id = 'another-candidate';
  await assert.rejects(f.uc.receive({ authorization: `Bearer ${other.token.token}`, body: JSON.stringify(payload) }), { reason: 'EXECUTION_CANDIDATE_MISMATCH' });
});
