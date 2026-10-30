/**
 * Project-scoped eligibility under 21 CFR 11.10(g).
 *
 * The motivating case had ten QA leads across ten projects, one lead per
 * project. Before project scoping, a QA lead grant for Task authorized each
 * lead on all ten projects. The signers were eligible people, but their
 * grants covered the wrong records.
 *
 * These tests forbid a grant for one project from satisfying another.
 * A missing match must never grant permission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowAuthorises, anyAuthorises, describeScope,
  ELIGIBILITY_PREDICATE, eligibilityParams
} from '../src/lib/eligibility.js';

const AP = '10001';
const OTHER = '10002';
const TASK = '10007';
const STORY = '10008';

const grant = (over = {}) => ({
  account_id: 'lead-1', issue_type_id: TASK, role: 'QA', state: 'ACTIVE',
  project_id: AP, ...over
});

const scope = (over = {}) => ({ projectId: AP, issueTypeId: TASK, role: 'QA', ...over });

// --- the ten-leads-ten-projects case -------------------------------------

test('a project-scoped grant authorises its own project', () => {
  assert.equal(rowAuthorises(grant(), scope()), true);
});

test('a project-scoped grant does NOT authorise another project', () => {
  // The whole point of the change.
  assert.equal(rowAuthorises(grant({ project_id: AP }), scope({ projectId: OTHER })), false);
});

test('ten leads scoped one project each authorise exactly one project each', () => {
  const projects = ['10001', '10002', '10003', '10004', '10005'];
  const grants = projects.map((p, i) => grant({ account_id: `lead-${i}`, project_id: p }));

  for (const p of projects) {
    const authorised = grants.filter((g) => rowAuthorises(g, scope({ projectId: p })));
    assert.equal(authorised.length, 1, `project ${p} should have exactly one authorised lead`);
  }
});

// --- site-wide grants -----------------------------------------------------

test('a null project is a site-wide grant', () => {
  const siteWide = grant({ project_id: null });
  assert.equal(rowAuthorises(siteWide, scope({ projectId: AP })), true);
  assert.equal(rowAuthorises(siteWide, scope({ projectId: OTHER })), true);
  assert.equal(rowAuthorises(siteWide, scope({ projectId: '99999' })), true);
});

test('site-wide still respects role and issue type', () => {
  const siteWide = grant({ project_id: null });
  assert.equal(rowAuthorises(siteWide, scope({ role: 'LEAD' })), false);
  assert.equal(rowAuthorises(siteWide, scope({ issueTypeId: STORY })), false);
});

// --- nothing widens -------------------------------------------------------

test('a revoked grant authorises nothing, whatever its scope', () => {
  assert.equal(rowAuthorises(grant({ state: 'REVOKED' }), scope()), false);
  assert.equal(rowAuthorises(grant({ state: 'REVOKED', project_id: null }), scope()), false);
});

test('a missing row is not permission', () => {
  assert.equal(rowAuthorises(null, scope()), false);
  assert.equal(rowAuthorises(undefined, scope()), false);
});

test('an unknown project on the scope side does not match a scoped grant', () => {
  assert.equal(rowAuthorises(grant(), scope({ projectId: null })), false);
  assert.equal(rowAuthorises(grant(), scope({ projectId: undefined })), false);
});

test('ids compare as strings, so 10001 and "10001" agree', () => {
  // project_id is BIGINT and arrives as a number from some paths and a string
  // from others. A type mismatch here would silently deny every signature.
  assert.equal(rowAuthorises(grant({ project_id: 10001 }), scope({ projectId: '10001' })), true);
  assert.equal(rowAuthorises(grant({ project_id: '10001' }), scope({ projectId: 10001 })), true);
  assert.equal(rowAuthorises(grant({ project_id: 10001 }), scope({ projectId: 10002 })), false);
});

// --- any-of --------------------------------------------------------------

test('one qualifying grant among many is enough', () => {
  const rows = [
    grant({ project_id: OTHER }),
    grant({ role: 'LEAD' }),
    grant({ issue_type_id: STORY }),
    grant({ project_id: AP })
  ];
  assert.equal(anyAuthorises(rows, scope()), true);
});

test('a pile of near-misses is still a refusal', () => {
  const rows = [
    grant({ project_id: OTHER }),
    grant({ role: 'LEAD' }),
    grant({ issue_type_id: STORY }),
    grant({ state: 'REVOKED', project_id: null })
  ];
  assert.equal(anyAuthorises(rows, scope()), false);
});

test('no grants at all is a refusal', () => {
  assert.equal(anyAuthorises([], scope()), false);
  assert.equal(anyAuthorises(null, scope()), false);
});

// --- the SQL and the in-memory rule must agree ---------------------------

test('the shared predicate keeps both check sites honest', () => {
  // gate.js and panel.js both interpolate this string. If it stopped allowing
  // NULL, every existing site-wide grant would silently stop working; if it
  // stopped binding project_id, project scoping would silently stop applying.
  assert.match(ELIGIBILITY_PREDICATE, /project_id = \? OR project_id IS NULL/);
  assert.match(ELIGIBILITY_PREDICATE, /account_id = \?/);
  assert.match(ELIGIBILITY_PREDICATE, /state = \?/);

  const params = eligibilityParams({
    accountId: 'a', issueTypeId: TASK, role: 'QA', state: 'ACTIVE', projectId: 10001
  });
  assert.equal(params.length, 5, 'one bind per placeholder in the predicate');
  assert.equal(params[4], '10001', 'project bound as a string, matching rowAuthorises');
});

test('a null project binds as null rather than the string "null"', () => {
  const params = eligibilityParams({
    accountId: 'a', issueTypeId: TASK, role: 'QA', state: 'ACTIVE', projectId: null
  });
  assert.equal(params[4], null);
});

// --- how it reads in the console -----------------------------------------

test('scope is described in words, with the wider grant named explicitly', () => {
  assert.equal(describeScope(grant({ project_id: null })), 'All projects');
  assert.equal(describeScope(grant({ project_id: AP }), 'Autograph'), 'Autograph only');
  assert.equal(describeScope(grant({ project_id: AP }), null), 'Project 10001 only');
});
