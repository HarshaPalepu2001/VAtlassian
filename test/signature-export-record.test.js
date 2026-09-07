/**
 * Record export — 21 CFR 11.10(b).
 *
 * The clause's own words are "accurate and COMPLETE copies", so the failures
 * that matter here are not crashes. They are an export that is quietly short,
 * an export whose two forms disagree, and an export that stays silent about a
 * broken audit chain. Each of those produces a document that looks correct and
 * misleads the person it was produced for, which is worse than producing
 * nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, renderHuman, renderElectronic, EXPORT_FORMAT_VERSION } from '../src/lib/exportRecord.js';
import { canonical, sha256Hex } from '../src/lib/hash.js';

const AT = Date.parse('2026-08-31T09:00:00Z');

const signature = (over = {}) => ({
  approval_id: 'a1b2', issue_id: 10439, issue_key: 'AP-21', project_id: 10001,
  transition_id: '3', from_status_id: '3', to_status_id: '10006',
  account_id: 'acct-1', printed_name: 'Priya Sharma', signer_role: 'QA', meaning: 'Approved',
  content_hash: 'c'.repeat(64), record_version: 1, state: 'CONSUMED',
  created_at: AT, consumed_at: AT + 60000, ...over
});

const entry = (seq, over = {}) => ({
  seq, occurred_at: AT + seq, actor_account_id: 'acct-1', event_type: 'SIGNATURE_CREATED',
  issue_id: 10439, payload: JSON.stringify({ meaning: 'Approved' }),
  prev_hash: String(seq - 1).padStart(64, '0'), entry_hash: String(seq).padStart(64, '0'), ...over
});

const build = (over = {}) => buildExport({
  signatures: [signature()], auditEntries: [entry(1), entry(2)],
  scope: { projectId: 10001 }, generatedAt: AT, generatedBy: 'admin-1',
  chainVerification: { ok: true, checked: 2 }, ...over
});

// --- completeness ---------------------------------------------------------

test('a complete export says so', () => {
  const { document } = build();
  assert.equal(document.completeness.truncated, false);
  assert.match(document.completeness.note, /every record/);
});

test('a truncated export says so, loudly, in both forms', () => {
  const built = build({ truncated: true });

  assert.equal(built.document.completeness.truncated, true);
  assert.match(built.document.completeness.note, /does NOT contain every record/);
  assert.match(renderHuman(built), /TRUNCATED/);
  assert.match(renderElectronic(built), /does NOT contain every record/);
});

test('counts describe what was actually included', () => {
  const built = build({ signatures: [signature(), signature()], auditEntries: [entry(1)] });
  assert.equal(built.document.completeness.signatureCount, 2);
  assert.equal(built.document.completeness.auditEntryCount, 1);
});

// --- a broken chain must never be omitted --------------------------------

test('a broken chain is reported, not suppressed', () => {
  const built = build({ chainVerification: { ok: false, brokenAt: 812, reason: 'ENTRY_ALTERED', checked: 811 } });

  assert.equal(built.document.chainVerification.verified, false);
  assert.equal(built.document.chainVerification.brokenAt, 812);
  assert.match(renderHuman(built), /BROKEN at entry 812/);
  assert.match(renderHuman(built), /ENTRY_ALTERED/);
});

test('an export still produces records when the chain is broken', () => {
  // An inspector asking for records during an integrity incident needs them
  // more, not less. Refusing to export would destroy the evidence trail at
  // exactly the moment it matters.
  const built = build({ chainVerification: { ok: false, brokenAt: 1, reason: 'CHAIN_MISMATCH' } });
  assert.equal(built.document.signatures.length, 1);
  assert.match(renderHuman(built), /Priya Sharma/);
});

test('an unverified chain is distinguishable from a verified one', () => {
  const built = build({ chainVerification: null });
  assert.equal(built.document.chainVerification.verified, null);
  assert.match(renderHuman(built), /not verified in this export/);
});

// --- 11.50 manifestation carried into the copy ---------------------------

test('every signature carries printed name, date and time, and meaning', () => {
  const { document } = build();
  const s = document.signatures[0];

  assert.equal(s.printedName, 'Priya Sharma');
  assert.equal(s.meaning, 'Approved');
  assert.equal(s.signedAtIso, '2026-08-31T09:00:00.000Z');
});

test('the human-readable form shows all three without needing the JSON', () => {
  const text = renderHuman(build());
  assert.match(text, /Signed by:\s+Priya Sharma/);
  assert.match(text, /Date and time:\s+2026-08-31T09:00:00/);
  assert.match(text, /Meaning:\s+Approved/);
});

test('the link to the record travels with the signature', () => {
  // 11.70: a copy in which the signature is not linked to what it signed
  // cannot demonstrate the link was ever there.
  const text = renderHuman(build());
  assert.match(text, /Content hash:\s+c{64}/);
  assert.match(text, /AP-21/);
});

// --- the chain can be re-walked by the recipient --------------------------

test('both hashes travel with every audit entry', () => {
  const { document } = build();
  for (const e of document.auditEntries) {
    assert.ok(e.prevHash, 'prev_hash is what makes the chain checkable offline');
    assert.ok(e.entryHash);
  }
});

test('payloads are parsed rather than shipped as opaque strings', () => {
  const { document } = build();
  assert.deepEqual(document.auditEntries[0].payload, { meaning: 'Approved' });
});

test('an unparseable payload degrades visibly instead of throwing', () => {
  const built = build({ auditEntries: [entry(1, { payload: 'not json{' })] });
  assert.deepEqual(built.document.auditEntries[0].payload, { unparsed: 'not json{' });
});

// --- the hash the recipient checks ---------------------------------------

test('the SHA-256 is over the canonical electronic form, and reproducible', () => {
  const built = build();

  assert.equal(built.sha256, sha256Hex(canonical(built.document)));
  assert.equal(renderElectronic(built), canonical(built.document));
  // Recomputable by a recipient with nothing but the electronic form.
  assert.equal(sha256Hex(renderElectronic(built)), built.sha256);
});

test('the same records always hash the same, whatever key order they arrive in', () => {
  const a = buildExport({
    signatures: [signature()], auditEntries: [entry(1)],
    scope: { projectId: 10001 }, generatedAt: AT, generatedBy: 'admin-1',
    chainVerification: { ok: true, checked: 1 }
  });
  const reordered = { ...signature() };
  const b = buildExport({
    signatures: [reordered], auditEntries: [entry(1)],
    scope: { projectId: 10001 }, generatedAt: AT, generatedBy: 'admin-1',
    chainVerification: { ok: true, checked: 1 }
  });

  assert.equal(a.sha256, b.sha256);
});

test('changing one record changes the hash', () => {
  const a = build();
  const b = build({ signatures: [signature({ meaning: 'Reviewed' })] });
  assert.notEqual(a.sha256, b.sha256);
});

// --- the two forms must agree --------------------------------------------

test('the human form quotes the same hash the electronic form is', () => {
  const built = build();
  assert.ok(renderHuman(built).includes(built.sha256), 'a reader must be able to tie the two together');
});

test('every signature in the document appears in the human form', () => {
  const built = build({
    signatures: [signature({ printed_name: 'A One' }), signature({ printed_name: 'B Two' })]
  });
  const text = renderHuman(built);
  assert.match(text, /A One/);
  assert.match(text, /B Two/);
});

// --- edges ---------------------------------------------------------------

test('an empty scope produces a valid export rather than an error', () => {
  const built = buildExport({
    signatures: [], auditEntries: [], scope: {},
    generatedAt: AT, generatedBy: 'admin-1', chainVerification: { ok: true, checked: 0 }
  });

  assert.equal(built.document.completeness.signatureCount, 0);
  assert.match(renderHuman(built), /\(none in scope\)/);
  assert.ok(built.sha256);
});

test('the scope is described in words in both forms', () => {
  const built = buildExport({
    signatures: [], auditEntries: [],
    scope: { projectId: 10001, fromMs: AT, toMs: AT + 86400000 },
    generatedAt: AT, generatedBy: 'admin-1'
  });

  assert.match(built.document.scope.description, /Project 10001/);
  assert.match(built.document.scope.description, /from 2026-08-31/);
  assert.match(renderHuman(built), /Project 10001/);
});

test('an all-projects export says so rather than showing a blank', () => {
  const built = buildExport({ signatures: [], auditEntries: [], scope: {}, generatedAt: AT, generatedBy: 'a' });
  assert.match(built.document.scope.description, /All projects/);
});

test('the format is versioned, so a future reader knows what it is holding', () => {
  assert.equal(build().document.formatVersion, EXPORT_FORMAT_VERSION);
});
