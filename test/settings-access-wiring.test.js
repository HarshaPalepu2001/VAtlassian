import test from 'node:test';
import assert from 'node:assert/strict';
import * as admin from '../src/usecases/admin.js';
import { fixture, request } from './admin-fixture.js';
import { rowAuthorises } from '../src/lib/eligibility.js';

// Model the BINARY(16) boundary that the ordinary admin fixture omits.
test('role grants survive binary storage, read back, authorize every matching scope, and revoke', async () => {
  let row;
  const deps = fixture({ query: (sql, params) => {
    if (sql.startsWith('INSERT INTO va_eligibility')) {
      const bytes = /VALUES\s*\(FROM_BASE64\(\?\)/.test(sql) ? Buffer.from(params[0], 'base64') : Buffer.from(params[0]);
      if (bytes.length !== 16) return { result: false };
      row = { el_id: bytes.toString('base64'), account_id: params[1], issue_type_id: params[2], role: params[3], state: params[4], project_id: params[8], display_name: params[7] };
    }
    if (sql.startsWith('UPDATE va_eligibility')) {
      if (!/el_id = FROM_BASE64\(\?\)/.test(sql)) return { result: true, data: { affectedRows: 0 } };
      if (row?.el_id === params[1]) { row.state = params[0]; return { result: true, data: { affectedRows: 1 } }; }
    }
    return { result: true, data: sql.includes('SELECT TO_BASE64(el_id)') ? (row?.state === 'ACTIVE' ? [row] : []) : { affectedRows: 1 } };
  } });
  const grant = await admin.grantEligibility(request({ targetAccountId: 'reviewer', projectId: '*', issueTypeId: '*', role: 'QA' }), deps);
  assert.equal(grant.success, true, grant.error);
  const listed = await admin.listEligibility(request(), deps);
  assert.equal(listed.grants[0].elId, grant.elId);
  assert.equal(row.display_name, 'User reviewer');
  for (const projectId of ['1', '2', '99999']) for (const issueTypeId of ['2', '3', '99999']) {
    assert.equal(rowAuthorises(row, { projectId, issueTypeId, role: 'QA' }), true);
  }
  const revoked = await admin.revokeEligibility(request({ elId: grant.elId }), deps);
  assert.equal(revoked.success, true, revoked.error);
  assert.equal(rowAuthorises(row, { projectId: '1', issueTypeId: '2', role: 'QA' }), false);
  assert.deepEqual((await admin.listEligibility(request(), deps)).grants, []);
});

test('revoking a missing role grant cannot report success', async () => {
  const deps = fixture({ query: () => ({ result: true, data: { affectedRows: 0 } }) });
  assert.equal((await admin.revokeEligibility(request({ elId: 'a'.repeat(32) }), deps)).success, false);
});

test('a Jira administrator recovering the roster can search for the person to appoint', async () => {
  const deps = fixture({ unauthorized: true });
  deps.route = (parts, ...values) => parts.reduce((s, part, i) => s + part + (values[i] ?? ''), '');
  deps.asApp = () => ({ requestJira: async () => ({ ok: true, json: async () => [{ accountId: 'reviewer', displayName: 'Reviewer', active: true }] }) });
  const result = await admin.searchUsers(request({ query: 'Reviewer' }), deps);
  assert.equal(result.success, true, result.error);
  assert.equal(result.users[0].accountId, 'reviewer');
});

test('all-project role grants can be restricted to a single work type', async () => {
  const deps = fixture();
  deps.route = (parts, ...values) => parts.reduce((s, part, i) => s + part + (values[i] ?? ''), '');
  deps.asApp = () => ({ requestJira: async path => {
    assert.equal(path, '/rest/api/3/issuetype');
    return { ok: true, json: async () => [{ id: '2', name: 'Requirement' },
      { id: '10050', name: 'Requirement', scope: { type: 'PROJECT', project: { id: '10001' } } }] };
  } });
  // A team-managed project's own copy of a type would match that project only.
  assert.deepEqual((await admin.listIssueTypesForProject(request({ projectId: '*' }), deps)).issueTypes, [{ id: '2', name: 'Requirement', subtask: false }]);
});

test('removing a transition refuses a stale revision and cannot remove a changed policy', async () => {
  const deps = fixture({ query: () => ({ result: true, data: [{ state: 'ACTIVE', required_role: 'Changed role' }] }) });
  const result = await admin.revokeControlledTransition(request({ ctId: 'a'.repeat(32), expectedRevision: 'stale' }), deps);
  assert.equal(result.success, false);
  assert.match(result.error, /changed|Reload/i);
  assert.equal(deps.calls.some(c => c.sql.startsWith('UPDATE')), false);
});

test('a transition removed concurrently cannot be reported as successfully removed', async () => {
  const deps = fixture({ query: () => ({ result: true, data: { affectedRows: 0 } }) });
  assert.equal((await admin.revokeControlledTransition(request({ ctId: 'a'.repeat(32) }), deps)).success, false);
});
