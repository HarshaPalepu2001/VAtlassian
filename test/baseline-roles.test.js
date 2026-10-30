import test from 'node:test';
import assert from 'node:assert/strict';

import { ROLE, ROLES, ROLE_IDS, DEFAULT_ROLE, isRole, normaliseRole, roleLabel } from '../src/lib/roles.js';
import { rowAuthorises } from '../src/lib/eligibility.js';

/**
 * Role names must match exactly.
 *
 * A gate stores required_role and a grant stores role. lib/eligibility.js
 * compares them byte for byte. The values previously came from unrelated
 * free-text inputs. These tests require one shared list and no coercion.
 * Adding trim() or toUpperCase() anywhere on the path must fail a test
 * before it causes valid customer transitions to be refused.
 */

test('the canonical list is non-empty and every id is a distinct, bare uppercase token', () => {
  assert.ok(ROLES.length > 0);
  assert.equal(new Set(ROLE_IDS).size, ROLE_IDS.length, 'duplicate role ids');
  for (const id of ROLE_IDS) {
    assert.match(id, /^[A-Z][A-Z0-9_]*$/, `${id} is not a bare uppercase token`);
    assert.equal(id, id.trim(), `${id} carries whitespace`);
  }
});

test('every role carries a label and help text, because both screens render them', () => {
  for (const r of ROLES) {
    assert.ok(r.label && r.label.length > 0, `${r.id} has no label`);
    assert.ok(r.help && r.help.length > 0, `${r.id} has no help text`);
  }
});

test('the default role is itself a member of the list', () => {
  assert.ok(isRole(DEFAULT_ROLE));
  assert.equal(DEFAULT_ROLE, ROLE.REVIEWER);
});

test('normaliseRole returns null rather than falling back to the default', () => {
  // THE POINT: a save that quietly rewrote an unrecognised role as REVIEWER
  // would grant authority the administrator never chose. The resolvers refuse
  // the write instead, and this is what makes them able to.
  assert.equal(normaliseRole('NOPE'), null);
  assert.equal(normaliseRole(''), null);
  assert.equal(normaliseRole(null), null);
  assert.equal(normaliseRole(undefined), null);
});

test('normaliseRole does NOT repair near-misses, because eligibility will not either', () => {
  // Each of these is exactly the mistake two free-text inputs used to produce.
  // Accepting any of them here would mean storing a value that
  // ELIGIBILITY_PREDICATE cannot match, which denies every transition while
  // both admin screens read as correct.
  for (const nearMiss of ['reviewer', 'Reviewer', 'REVIEWER ', ' REVIEWER', 'REVIEWER\t']) {
    assert.equal(normaliseRole(nearMiss), null, `${JSON.stringify(nearMiss)} was accepted`);
  }
  assert.equal(normaliseRole('REVIEWER'), 'REVIEWER');
});

test('a role that survives normalisation authorises a matching grant', () => {
  const role = normaliseRole(ROLE.REVIEWER);
  const grant = { state: 'ACTIVE', role, issue_type_id: '*', project_id: '10000' };
  assert.equal(rowAuthorises(grant, { projectId: '10000', issueTypeId: '10001', role }), true);
});

test('the near-misses that normalisation rejects would indeed have failed eligibility', () => {
  // The two halves of the guarantee, checked against each other: what
  // normaliseRole refuses is precisely what rowAuthorises would not have
  // matched. If either side ever starts folding case or trimming, this fails.
  const gateRole = 'REVIEWER';
  for (const granted of ['reviewer', 'Reviewer', 'REVIEWER ']) {
    const grant = { state: 'ACTIVE', role: granted, issue_type_id: '*', project_id: null };
    assert.equal(
      rowAuthorises(grant, { projectId: '10000', issueTypeId: '10001', role: gateRole }),
      false,
      `${JSON.stringify(granted)} unexpectedly satisfied a ${gateRole} gate`
    );
  }
});

test('roleLabel falls back to the id rather than throwing on an unknown role', () => {
  // Rows written before a role was retired still have to render in the console.
  assert.equal(roleLabel('REVIEWER'), 'Reviewer');
  assert.equal(roleLabel('LEGACY_ROLE'), 'LEGACY_ROLE');
  assert.equal(roleLabel(null), '');
});
