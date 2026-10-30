import { driftedFields } from './interception.js';
import { scopeFromIssue } from './trackedFields.js';
import { harnessLog } from './harnessLogger.js';
import { baselineLinkPolicy, hydrateLinkPolicyIssue } from './linkPolicy.js';

/**
 * Compare a work item's tracked fields with its active baseline.
 *
 * The panel in usecases/panelSummary.js and validator in lib/approval/runtime.js
 * share this comparison. They must agree so a drift hold always has a
 * corresponding decision in the panel.
 *
 * Controlled-transition captures produce TREE baselines whose digests live on
 * the root node. Their va_baseline row holds '{}'. Comparing to that empty map
 * would report drift on every read. If root digests are unreadable, the '{}'
 * fallback over-reports drift rather than clearing a hold.
 *
 * diagnostics reports flagged fields, baseline readability and the digest
 * source. It includes shortened digests and no field values, so it can be logged.
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
  // Read a tree root with parent = null, as lib/tree/jira.js captures it.
  // An independently re-baselined child has no covering capture and therefore
  // records that null too. Comparing its real Jira parent produced drift that
  // recapture could never clear.
  //
  // Use === null, not a falsy check. Rows predating captured_by have undefined,
  // which does not establish that the item has no covering capture.
  const parentOutsideTree = Boolean(baseline.tree_hash) && baseline.captured_by_baseline_id === null
    && issueId != null && Number(baseline.issue_id) === Number(issueId);
  const comparedFields = parentOutsideTree && issueFields && typeof issueFields === 'object'
    ? { ...issueFields, parent: null } : issueFields;
  const linkPolicy = baselineLinkPolicy(baseline);
  const hydrated = await hydrateLinkPolicyIssue({ id: issueId, fields: comparedFields }, linkPolicy);
  const result = driftedFields({ baselineDigests, issueFields: hydrated.fields, controlledFields, linkPolicy, issue: hydrated });
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
    // BASELINE_UNREADABLE reports every scoped field because approved content
    // could not be read. DIGEST_MISMATCH identifies actual differences from readable
    // digests.
    cause: changed.length === 0 ? null : (result.baselineReadable === false ? 'BASELINE_UNREADABLE' : 'DIGEST_MISMATCH'),
    fields: changed.slice(0, MAX_FIELDS_LISTED).map(field => ({
      field, baseline: short(previous?.[field]), current: short(current[field])
    }))
  };
}

/**
 * Log each live comparison that holds an item, whether requested by the gate,
 * signing form, panel summary or diagnostics. Log nothing when no fields differ.
 *
 * typeChangedSinceBaseline helps explain scope mismatches because tracked fields
 * and transition rules use the current work-item type while baselines retain
 * their capture-time type.
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
