/**
 * AUTHORSHIP — who wrote a test version or a plan revision, so that none of
 * them signs it.
 *
 * Independent review of a test specification (ISO 26262-8 clause 9, ASPICE
 * SWE.4–SWE.6, a GxP "second person") means its author never approves it.
 * This is separate from the chain: `distinctSigners` is about signers among
 * themselves, the author rule is about the content.
 *
 * The rule is the project's switch (`authorSeparation`, Test management page),
 * read when someone signs, not when the version was published: switching it
 * on covers every version still waiting for sign-off. Off is not compliant;
 * it exists for single-person trials. Authors are recorded either way, and
 * every signature's audit entry says whether the rule was on.
 *
 * The authors of a version are everyone who edited the draft, or published a
 * version, since the last signed one. Content that was published and never
 * signed (rejected, superseded) carries its authors into the next version: a
 * republish by someone else does not launder who wrote it.
 *
 * A draft keeps its editors as `[{ accountId, revision }]`, the draft revision
 * each one last saved. A version stores `{ accounts, draftRevision }`, the
 * draft revision it was published from, so the next version knows where the
 * signed content ended.
 */

/** The draft's editors after `accountId` saved it as `revision`. */
export function withEditor(editors, accountId, revision) {
  const others = (Array.isArray(editors) ? editors : []).filter(e => e?.accountId && e.accountId !== accountId);
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
  // A draft saved before editors were recorded names only its last editor.
  if (draft?.editors == null && draft?.updatedBy) accounts.add(draft.updatedBy);
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
