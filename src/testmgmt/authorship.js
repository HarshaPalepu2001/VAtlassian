/**
 * Track test-version and plan-revision authors for independent review under
 * ISO 26262-8 clause 9, ASPICE SWE.4 through SWE.6 and GxP second-person review.
 * Authors cannot approve their own content when authorSeparation is enabled.
 * distinctSigners separately controls whether chain signers must differ.
 *
 * Read authorSeparation at signing time, so enabling it covers versions still
 * awaiting sign-off. Disabled mode is for single-person trials and does not
 * meet independent-review requirements. Always record authors and include
 * the setting in each signature's audit entry.
 *
 * Include everyone who edited or published since the last signed version.
 * Rejected or superseded unsigned versions retain their authors on the next
 * version, even if someone else republishes.
 *
 * Draft editors use [{ accountId, revision }]. Versions store
 * { accounts, draftRevision } to identify where the last signed content ended.
 */

/**
 * The draft's editors after `accountId` saved it as `revision`. A draft saved
 * before editors were recorded starts from its last editor, so the first save
 * after the upgrade never drops who wrote it.
 */
export function withEditor(draft, accountId, revision) {
  const known = Array.isArray(draft?.editors) ? draft.editors
    : draft?.updatedBy ? [{ accountId: draft.updatedBy, revision: Number(draft.revision) }] : [];
  const others = known.filter(e => e?.accountId && e.accountId !== accountId);
  return [...others, { accountId, revision: Number(revision) }];
}

/**
 * The authors frozen with a new version.
 *
 * `draft` is the draft being published (`editors`, `updatedBy`, `revision`);
 * `history` is every earlier version or revision of the subject, newest first
 * (`state`, `publishedBy`, `authors`).
 */
export function authorsFor({ draft, history, publisher }) {
  const lastSigned = (history ?? []).find(v => v.state === 'SIGNED') ?? null;
  // A signed version published before authors were recorded has no draft
  // revision: every editor recorded since counts.
  const since = Number(lastSigned?.authors?.draftRevision ?? 0);
  const accounts = new Set();
  for (const e of draft?.editors ?? []) if (Number(e.revision) > since) accounts.add(e.accountId);
  // A draft saved before editors were recorded, or whose list cannot be read,
  // names only its last editor.
  if (!Array.isArray(draft?.editors) && draft?.updatedBy) accounts.add(draft.updatedBy);
  for (const v of history ?? []) {
    if (v === lastSigned) break;
    if (v.publishedBy) accounts.add(v.publishedBy);
    for (const a of v.authors?.accounts ?? []) accounts.add(a);
  }
  accounts.add(publisher);
  return { accounts: [...accounts].sort(), draftRevision: Number(draft?.revision ?? 0) };
}

/** The accounts that wrote a version; one stored before authors were recorded has its publisher. */
export function authorsOf(version) {
  const accounts = version?.authors?.accounts;
  return Array.isArray(accounts) && accounts.length ? accounts : [version?.publishedBy].filter(Boolean);
}

/** Why this person may not sign this version, or null. Only while the project's rule is on. */
export function authorProblem(version, accountId, enforced) {
  return enforced === true && authorsOf(version).includes(accountId) ? 'AUTHOR_CANNOT_SIGN' : null;
}
