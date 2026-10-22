import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareApprovalLinkPolicy } from '../src/lib/approval/linkPolicy.js';
import { project } from '../src/lib/content.js';

const policy = { version: 2, verifiesTypeId: '90', testTypes: [{ projectId: 1, issueTypeId: '20' }], internalTypeIds: [] };
const fields = [{ field_id: 'issuelinks', field_kind: 'LINKS', store_values: true }];
const source = { id: '10', fields: { project: { id: '1' }, issuetype: { id: '30' }, issuelinks: [
  { type: { id: '90' }, inwardIssue: { id: '11', fields: { project: { id: '1' }, issuetype: { id: '20' } } } }
] } };
const prepared = () => ({ issue: source, fields, evidenceHash: 'standing evidence', baseline: {} });

test('full approval freezes the new policy without replacing reviewed standing evidence', async () => {
  const next = await prepareApprovalLinkPolicy(prepared(), { decision: 'APPROVE', resolve: async () => policy });
  assert.deepEqual(next.linkPolicy, policy);
  assert.equal(next.evidenceHash, 'standing evidence');
  assert.equal(next.contentHash, project({ issuelinks: [] }, fields, { issue: source, linkPolicy: policy }).contentHash);
  assert.notEqual(next.contentHash, project(source.fields, fields).contentHash);
});

test('a legacy approval replay never consults current configuration', async () => {
  const next = await prepareApprovalLinkPolicy(prepared(), { decision: 'APPROVE', linkPolicy: null,
    resolve: async () => { throw new Error('must not resolve'); } });
  assert.equal(next.contentHash, project(source.fields, fields).contentHash);
  assert.deepEqual(next.linkPolicy, { version: 1 });
});

test('reject and mixed preserve the standing policy instead of opting into configuration', async () => {
  for (const decision of ['REJECT', 'MIXED']) {
    const next = await prepareApprovalLinkPolicy(prepared(), { decision, resolve: async () => { throw new Error('must not resolve'); } });
    assert.deepEqual(next.linkPolicy, { version: 1 });
    assert.equal(next.contentHash, project(source.fields, fields).contentHash);
  }
});
