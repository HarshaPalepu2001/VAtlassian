import { driftedFields } from './interception.js';
import { scopeFromIssue } from './trackedFields.js';
import { harnessLog } from './harnessLogger.js';

/**
 * WHICH TRACKED FIELDS OF THIS WORK ITEM NO LONGER MATCH ITS ACTIVE BASELINE?
 *
 * The one live answer, shared by the panel (usecases/panelSummary.js) and the
 * validator (lib/approval/runtime.js). The validator holds an item still while
 * this reports a change, and the panel is where that change is decided — so the
 * two must reach the same verdict by construction, or an item is held with
 * nothing on the panel to approve or reject.
 *
 * A TREE baseline — every one a controlled transition captures — keeps its
 * digests on the root node, not on the va_baseline row, which it leaves as
 * '{}'. Comparing against that empty map fails towards drift on every read.
 * If the root node's digests cannot be read, the '{}' fallback still
 * over-reports rather than clearing.
 *
 * THE RESULT ALSO SAYS WHY. `diagnostics` is what a held item needs when this
 * disagrees with the panel's own diff: which fields were flagged, whether the
 * baseline could be read at all, and where its digests came from. Digests are
 * shortened and values never appear, so it is safe to log.
 */
export async function baselineDrift({ baseline, issueId, issueFields, declared, readRootDigests }) {
  if (!baseline) return { changed: [], contentHash: null, diagnostics: { cause: null, baselinePresent: false } };

  let baselineDigests = baseline.field_digests;
  let digestSource = 'baseline-row';
  let rootDigestError = null;
  if (baseline.tree_hash) {
    const root = await Promise.resolve()
      .then(() => readRootDigests(baseline.baseline_id, issueId))
      .catch((error) => { rootDigestError = error?.message ?? String(error); return null; });
    if (root != null) {
      baselineDigests = root;
      digestSource = 'root-node';
    } else {
      digestSource = rootDigestError ? 'root-node-error>baseline-row' : 'root-node-missing>baseline-row';
    }
  }

  const controlledFields = scopeFromIssue({ declared, issueFields }).fields;
  // A tree is read with its ROOT's Jira parent set to null (lib/tree/jira.js):
  // that parent lies outside the tree. So a baseline that is the root of its own
  // tree — a child re-baselined by a decision on it, with no covering parent
  // capture — recorded parent = null. Comparing the issue's real parent against
  // that null reported one field of drift that no new baseline could ever clear,
  // because each one recorded null again. Compare it as the tree saw it.
  //
  // `=== null` and not falsy: a baseline row read before captured_by existed
  // has it undefined, and that must not be mistaken for "not covered".
  const parentOutsideTree = Boolean(baseline.tree_hash) && baseline.captured_by_baseline_id === null
    && issueId != null && Number(baseline.issue_id) === Number(issueId);
  const comparedFields = parentOutsideTree && issueFields && typeof issueFields === 'object'
    ? { ...issueFields, parent: null } : issueFields;
  const result = driftedFields({ baselineDigests, issueFields: comparedFields, controlledFields });
  return { ...result, diagnostics: explain({ baseline, result, baselineDigests, digestSource, rootDigestError,
    scopeFieldCount: controlledFields.length, parentOutsideTree }) };
}

const short = value => (value == null ? null : String(value).slice(0, 10));
const MAX_FIELDS_LISTED = 40;

function parseDigests(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

function explain({ baseline, result, baselineDigests, digestSource, rootDigestError, scopeFieldCount, parentOutsideTree }) {
  const previous = parseDigests(baselineDigests);
  const current = result.digests ?? {};
  const changed = result.changed ?? [];
  return {
    baselinePresent: true,
    baselineVersion: baseline.version == null ? null : Number(baseline.version),
    baselineIssueTypeId: baseline.issue_type_id == null ? null : String(baseline.issue_type_id),
    digestSource,
    rootDigestError,
    baselineReadable: result.baselineReadable !== false,
    baselineKeyCount: previous ? Object.keys(previous).length : 0,
    currentKeyCount: Object.keys(current).length,
    scopeFieldCount,
    parentTreatedAsOutsideTree: parentOutsideTree === true,
    // BASELINE_UNREADABLE: nothing was compared — every field in scope is
    // reported because the approved state could not be read. DIGEST_MISMATCH:
    // the baseline was read and these fields genuinely differ from it.
    cause: changed.length === 0 ? null : (result.baselineReadable === false ? 'BASELINE_UNREADABLE' : 'DIGEST_MISMATCH'),
    fields: changed.slice(0, MAX_FIELDS_LISTED).map(field => ({
      field, baseline: short(previous?.[field]), current: short(current[field])
    }))
  };
}

/**
 * ONE LOG LINE FOR EVERY TIME THE LIVE CHECK HOLDS AN ITEM, from whichever
 * surface asked (gate, signing form, panel summary, diagnostics). Silent when
 * nothing is flagged, so a healthy item never adds noise.
 *
 * `typeChangedSinceBaseline` is the first thing to read when a rule seems not
 * to apply: controlled fields and transition rules are keyed by work item
 * type, and a baseline carries the type it was captured under.
 */
export function logLiveDrift(surface, { issueKey, issueTypeId, comparison, scope = null }) {
  const changed = comparison?.changed ?? [];
  if (changed.length === 0) return;
  const d = comparison.diagnostics ?? {};
  harnessLog('DRIFT', 'drift:live', {
    surface,
    issueKey,
    issueTypeId: issueTypeId == null ? null : String(issueTypeId),
    baselineIssueTypeId: d.baselineIssueTypeId ?? null,
    typeChangedSinceBaseline: d.baselineIssueTypeId != null && issueTypeId != null
      && String(d.baselineIssueTypeId) !== String(issueTypeId),
    baselineVersion: d.baselineVersion ?? null,
    digestSource: d.digestSource,
    rootDigestError: d.rootDigestError ?? null,
    baselineReadable: d.baselineReadable,
    baselineKeyCount: d.baselineKeyCount,
    currentKeyCount: d.currentKeyCount,
    scopeFieldCount: d.scopeFieldCount,
    parentTreatedAsOutsideTree: d.parentTreatedAsOutsideTree === true,
    // Whose fields the item was checked against: its own type's, or the root
    // that covers it (lib/tree/nodeFields.js). Null where the surface cannot say.
    scopeSource: scope?.source ?? null,
    scopeIssueTypeId: scope?.issueTypeId == null ? null : String(scope.issueTypeId),
    scopeRootIssueId: scope?.rootIssueId ?? null,
    cause: d.cause,
    changedCount: changed.length,
    changed: changed.slice(0, MAX_FIELDS_LISTED),
    fields: d.fields
  }, 'WARN');
}
