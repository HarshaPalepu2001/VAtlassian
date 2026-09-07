import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as retention from '../src/lib/retention.js';
import { buildExport, renderHuman } from '../src/lib/exportRecord.js';
import { entryHash } from '../src/lib/hash.js';

const now = 1800000000000;
const policy = retention.retentionPolicy({ 'retention.days': '365' });
const evidence = { sealed_at: 0, export_ref: 'archive:verified-copy', export_sha256: 'a'.repeat(64), verified_at: 1 };

test('malformed retention configuration cannot enable destructive pruning', () => {
  for (const days of ['365days', '365.2', '365e2', 'Infinity', '999999999999999999999']) {
    assert.equal(retention.retentionPolicy({ 'retention.days': days }).mayPrune, false, days);
  }
});
test('invalid evidence timestamps or digests refuse pruning', () => {
  for (const change of [{sealed_at:'oops'}, {verified_at:'bad'}, {export_sha256:'bad'}, {verified_at:now+1}]) {
    assert.equal(retention.prunable({...evidence,...change}, policy, now).prune, false);
  }
});
test('value pruning requires exact baseline coverage and keeps current values', () => {
  assert.equal(typeof retention.prunableValues, 'function');
  const baseline = {issue_id:12, version:1, content_hash:'b'.repeat(64)};
  const coverage = {...evidence, issueId:12, version:1, contentHash:baseline.content_hash, includesValues:true};
  assert.equal(retention.prunableValues(baseline, coverage, policy, now, 3).prune, true);
  for (const change of [{includesValues:false},{version:2},{issueId:13},{contentHash:'wrong'}]) {
    assert.equal(retention.prunableValues(baseline, {...coverage,...change}, policy, now, 3).prune, false);
  }
  assert.equal(retention.prunableValues(baseline, coverage, policy, now, 1).prune, false);
  assert.equal(retention.prunableValues(baseline, null, policy, now, 3).prune, false);
});
test('merged export includes baseline and approval assurance and re-verifiable audit linkage', () => {
  const row = {seq:1, occurred_at:now, actor_account_id:'u', event_type:'APPROVAL_RECORDED', issue_id:12,
    approval_id:'a1', payload:'{}', prev_hash:'0'.repeat(64)};
  row.entry_hash = entryHash({seq:1,occurredAt:now,actorAccountId:'u',eventType:row.event_type,issueId:12,
    approvalId:'a1',payload:{},prevHash:row.prev_hash});
  const result = buildExport({approvals:[{approval_id:'a1',assurance_level:'ESIGNATURE',signed_at:now}],
    baselines:[{baseline_id:'b1',approval_id:'a1',assurance_level:'NATIVE_TRANSITION',version:1}],
    auditEntries:[row],generatedAt:now,generatedBy:'admin'});
  assert.equal(result.document.approvals[0].assuranceLevel,'ESIGNATURE');
  assert.equal(result.document.baselines[0].assuranceLevel,'NATIVE_TRANSITION');
  assert.equal(result.document.auditEntries[0].approvalId,'a1');
  assert.match(renderHuman(result), /ESIGNATURE/);
  assert.match(renderHuman(result), /NATIVE_TRANSITION/);
  assert.equal(result.document.approvals[0].signedAt,now);
});
