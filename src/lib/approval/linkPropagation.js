import { project } from '../content.js';
import { canonical, sha256Hex } from '../hash.js';
import { linkKey, keyAtOtherEnd } from '../restore/linkConflicts.js';
import { governedLinks, excludesLink, normaliseLinkPolicy } from '../linkPolicy.js';

/**
 * ONE LINK CHANGE, ONE DECISION (decided 2026-09-28).
 *
 * A Jira link is one object that both issues list. Each issue's baseline
 * records its own links, so one link lives in two signed records — and before
 * this, approving a link change wrote only the approving issue's record.
 *
 * Found live: on 2026-09-26 "VAT-30 deploys VAT-3" was added while both were
 * baselined, so both drifted. It was approved on VAT-30 alone. From then on
 * VAT-30's record had the link and VAT-3's did not: a reject on VAT-3 would
 * undo VAT-30's signed approval (refused, lib/restore/linkConflicts.js), so
 * three signed rejects there changed nothing.
 *
 * Now the first decision on either end settles the link for both:
 *   - APPROVE records the link on the other issue too, as a new baseline
 *     version authenticated by the same approval. Only the link changes in that
 *     version; anything else undecided on the other issue stays undecided.
 *   - REJECT needs nothing here: restoring the link is one Jira write that both
 *     issues see, so both match their records again.
 * A new version, never an edit of an old one: the other issue's earlier signed
 * versions stay exactly as they were signed.
 *
 * This module is pure. jobs/linkWorker.js reads and writes.
 */

const LINKS_FIELD = { field_id: 'issuelinks', field_kind: 'LINKS', store_values: true };

/** The approved link changes between two lists as one issue lists them. */
export function linkChanges(before, after) {
  const was = new Map((before ?? []).map(link => [linkKey(link), link]));
  const now = new Map((after ?? []).map(link => [linkKey(link), link]));
  return [
    ...[...now].filter(([key]) => !was.has(key)).map(([, link]) => ({ change: 'add', link })),
    ...[...was].filter(([key]) => !now.has(key)).map(([, link]) => ({ change: 'remove', link }))
  ];
}

const otherIssueOf = link => link?.inwardIssue ?? link?.outwardIssue ?? null;

/**
 * The jobs one approval queues: one per other issue whose link it decided.
 * `before` is the approving issue's links as its previous record held them
 * ([] when it had no record; null when that record's links cannot be read,
 * which decides nothing). `after` is what this approval signed.
 */
export function linkDecisionJobs({ issue, tracksLinks, before, after, approval, linkPolicy = approval?.link_policy ?? approval?.linkPolicy }) {
  if (!tracksLinks || !Array.isArray(before) || !Array.isArray(after)) return [];
  const byOther = new Map();
  // Both sides of the comparison use the policy this approval actually signed.
  // A relationship outside that policy expresses no decision about either endpoint.
  for (const change of linkChanges(governedLinks(before, { linkPolicy, issue }), governedLinks(after, { linkPolicy, issue }))) {
    const other = otherIssueOf(change.link);
    const otherId = Number(other?.id);
    if (!Number.isSafeInteger(otherId) || otherId <= 0 || String(otherId) === String(issue.id)) continue;
    if (!byOther.has(otherId)) byOther.set(otherId, []);
    byOther.get(otherId).push({ change: change.change, link: change.link });
  }
  return [...byOther].map(([otherIssueId, changes]) => ({
    issueId: Number(issue.id), issueKey: String(issue.key), otherIssueId, changes,
    approvalId: approval.approvalId, approvedBy: approval.accountId, approvedName: approval.displayName,
    assuranceLevel: approval.assuranceLevel, signerRole: approval.signerRole ?? null
  }));
}

/**
 * The same link as the other issue lists it: the side flips and the issue it
 * names becomes the one that decided.
 */
export function mirrorLinkChange(link, decidedOn) {
  const side = link.inwardIssue ? 'outwardIssue' : 'inwardIssue';
  return { id: link.id, type: link.type, [side]: { id: String(decidedOn.id), key: decidedOn.key,
    ...(decidedOn.fields ? { fields: decidedOn.fields } : {}) } };
}

/**
 * The other issue's approved links with the decided changes applied, or null
 * when its record already agrees (nothing to record).
 */
export function applyLinkChanges({ links, decidedOn, changes, selfIssue, linkPolicy }) {
  const current = new Map((links ?? []).map(link => [linkKey(link), link]));
  let changed = false;
  for (const { change, link } of changes ?? []) {
    const mirrored = mirrorLinkChange(link, decidedOn);
    if (excludesLink({ linkPolicy, issue: selfIssue, link: mirrored })) continue;
    const key = keyAtOtherEnd(link, decidedOn.id);
    if (change === 'add' && !current.has(key)) { current.set(key, mirrored); changed = true; }
    if (change === 'remove' && current.has(key)) { current.delete(key); changed = true; }
  }
  return changed ? [...current.values()] : null;
}

/** A single-issue record with only its links replaced, hashed as capture hashes it. */
export function deriveFlatRecord({ values, digests, links, linkPolicy, issue }) {
  const projection = project({ issuelinks: links }, [LINKS_FIELD], { linkPolicy, issue });
  const nextDigests = { ...digests, issuelinks: projection.digests.issuelinks };
  return {
    values: { ...values, issuelinks: projection.raw.issuelinks },
    digests: nextDigests,
    contentHash: sha256Hex(canonical(nextDigests))
  };
}

/** A tree's hash from its stored nodes, exactly as ../tree/capturePlan.js computes it. */
export function treeHashOf(nodes) {
  return sha256Hex(canonical(nodes.map(node => ({
    id: node.logicalNodeId,
    parent: node.parentLogicalNodeId ?? null,
    hash: node.contentHash
  }))));
}

/**
 * A tree record with only its ROOT's links replaced. Children and structure
 * are copied as recorded: this decision is about the root's link, nothing else.
 */
export function deriveTreeRecord({ tree, links, linkPolicy, issue }) {
  const rootIndex = tree.nodes.findIndex(node => node.parentLogicalNodeId == null);
  if (rootIndex < 0) throw new Error('The recorded tree has no root node.');
  const root = tree.nodes[rootIndex];
  const rootPolicy = normaliseLinkPolicy(root.linkPolicy ?? tree.linkPolicy ?? linkPolicy);
  const rootIssue = issue ?? { id: String(root.currentIssueId ?? root.originalIssueId), key: root.issueKey,
    fields: { project: { id: root.projectId }, issuetype: { id: root.issueTypeId } } };
  const digests = typeof root.fieldDigests === 'string' ? JSON.parse(root.fieldDigests) : root.fieldDigests;
  const flat = deriveFlatRecord({ values: tree.values?.[root.logicalNodeId] ?? {}, digests, links, linkPolicy: rootPolicy, issue: rootIssue });
  const nodes = tree.nodes.map((node, index) => index === rootIndex
    ? { ...node, contentHash: flat.contentHash, fieldDigests: JSON.stringify(flat.digests),
      ...(rootPolicy.version === 2 || node.linkPolicy ? { linkPolicy: rootPolicy } : {}) }
    : node);
  return {
    nodes,
    values: { ...tree.values, [root.logicalNodeId]: flat.values },
    treeHash: treeHashOf(nodes),
    rootLogicalNodeId: root.logicalNodeId,
    ...(rootPolicy.version === 2 || tree.linkPolicy ? { linkPolicy: rootPolicy } : {})
  };
}

/** The links a record holds and whether it tracks them at all. */
export function recordedLinks({ digests, values }) {
  const parsed = typeof digests === 'string' ? safeParse(digests) : digests;
  const tracks = Boolean(parsed && Object.hasOwn(parsed, 'issuelinks'));
  return { tracks, digests: parsed, links: tracks && Array.isArray(values?.issuelinks) ? values.issuelinks : null };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
