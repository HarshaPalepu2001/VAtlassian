import test from 'node:test';
import assert from 'node:assert/strict';

import { rowAuthorises, anyAuthorises, ELIGIBILITY_PREDICATE } from '../src/lib/eligibility.js';

/**
 * THE WILDCARD IS THE WHOLE POINT OF THIS FILE.
 *
 * The admin console grants a reviewer with `issue_type_id = '*'`, because a
 * person trusted to review a Story is trusted to review the Bug beside it.
 * If the predicate matched that column exactly, the console could only ever
 * write rows nothing could find — and the failure would be silent: every
 * decision refused as "not an eligible reviewer", with a grant visible on the
 * screen saying otherwise.
 *
 * rowAuthorises() is the in-memory twin of ELIGIBILITY_PREDICATE. These tests
 * are what keep the two from drifting apart.
 */

const SCOPE = { projectId: 10001, issueTypeId: '10004', role: 'REVIEWER' };
const grant = (over = {}) => ({
  account_id: 'acc-1', issue_type_id: '10004', role: 'REVIEWER',
  state: 'ACTIVE', project_id: 10001, ...over
});

test("the SQL predicate and its in-memory twin both treat '*' as a wildcard", () => {
  assert.match(ELIGIBILITY_PREDICATE, /issue_type_id = \? OR issue_type_id = '\*'/);
  assert.equal(rowAuthorises(grant({ issue_type_id: '*' }), SCOPE), true);
});

test('an exact issue type still authorises', () => {
  assert.equal(rowAuthorises(grant(), SCOPE), true);
});

test('a grant naming a DIFFERENT issue type does not authorise', () => {
  assert.equal(rowAuthorises(grant({ issue_type_id: '10009' }), SCOPE), false);
});

test('a site-wide grant (project_id NULL) crosses projects', () => {
  assert.equal(rowAuthorises(grant({ project_id: null }), { ...SCOPE, projectId: 99999 }), true);
});

test('a project-scoped grant NEVER widens to another project', () => {
  assert.equal(rowAuthorises(grant(), { ...SCOPE, projectId: 10002 }), false);
});

test('a revoked grant authorises nothing, wildcard or not', () => {
  assert.equal(rowAuthorises(grant({ state: 'REVOKED', issue_type_id: '*' }), SCOPE), false);
});

test('the role must match exactly — there is no role wildcard', () => {
  assert.equal(rowAuthorises(grant({ role: 'APPROVER' }), SCOPE), false);
});

test('anyAuthorises finds the one wildcard grant among unrelated rows', () => {
  const rows = [
    grant({ issue_type_id: '10009' }),
    grant({ role: 'APPROVER' }),
    grant({ issue_type_id: '*', account_id: 'acc-2' })
  ];
  assert.equal(anyAuthorises(rows, SCOPE), true);
  assert.equal(anyAuthorises([rows[0], rows[1]], SCOPE), false);
});
