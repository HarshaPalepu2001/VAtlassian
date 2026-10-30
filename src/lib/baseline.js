import { project } from './content.js';
import { FIELD_KIND } from './content.js';
import { controlledFieldsHash } from './baselinePolicy.js';

/**
 * Reconstruct a baseline at the transition timestamp.
 *
 * avi:jira:transitioned:issue runs asynchronously. Edits between the transition
 * and this handler's read were not reviewed, so rewind them to transition_at.
 * Store the reconstruction fidelity in va_baseline.fidelity and show it in
 * the panel.
 *
 * EXACT means no later change occurred, or the changelog supplied a structured
 * from value for options, priorities, users, dates, plain text or labels.
 * RECONSTRUCTED means a rich-text change supplied only flattened fromString;
 * the result retains text but loses ADF structure. PARTIAL means attachments
 * or links could not be rewound, or the changelog could not be read.
 *
 * Do not present a reconstructed or partial baseline as exact.
 */

export const FIDELITY = {
  EXACT: 'EXACT',
  RECONSTRUCTED: 'RECONSTRUCTED',
  PARTIAL: 'PARTIAL'
};

const FIDELITY_ORDER = { EXACT: 0, RECONSTRUCTED: 1, PARTIAL: 2 };

/** The worst grade wins: a baseline is only as good as its weakest field. */
export function worstFidelity(grades) {
  let worst = FIDELITY.EXACT;
  for (const g of grades) {
    if (FIDELITY_ORDER[g] > FIDELITY_ORDER[worst]) worst = g;
  }
  return worst;
}

/**
 * Can a changelog item for this field kind be rewound faithfully?
 *
 * Keyed on FIELD_KIND rather than on the field id, so a custom rich-text field
 * gets the same honest RECONSTRUCTED grade that `description` does instead of
 * being quietly graded EXACT because nobody added it to a list.
 */
function rewindability(kind) {
  switch (kind) {
    case FIELD_KIND.TEXT:
    case FIELD_KIND.SCALAR:
    case FIELD_KIND.MULTI:
      return FIDELITY.EXACT;
    case FIELD_KIND.ADF:
      return FIDELITY.RECONSTRUCTED;
    case FIELD_KIND.ATTACHMENTS:
    case FIELD_KIND.LINKS:
    case FIELD_KIND.SUBTASKS:
      // These arrive as per-item add/remove rows with no whole-value `from`,
      // so there is nothing to rewind TO. Refusing to guess is the point.
      return FIDELITY.PARTIAL;
    default:
      return FIDELITY.PARTIAL;
  }
}

/**
 * Rebuild a field at transitionAt from the oldest post-transition change's
 * from value. The newest entry's from would restore only the previous edit,
 * not the value at the transition.
 */
function rewindField(kind, currentValue, items) {
  if (!items || items.length === 0) return { value: currentValue, fidelity: FIDELITY.EXACT };

  const grade = rewindability(kind);
  if (grade === FIDELITY.PARTIAL) {
    return { value: currentValue, fidelity: FIDELITY.PARTIAL };
  }

  // items arrive oldest-first (lib/changelog.js sorts them), so [0] is the
  // first change after the transition and its `from` is the approved value.
  const first = items[0];

  switch (kind) {
    case FIELD_KIND.TEXT:
      return { value: first.fromString ?? null, fidelity: FIDELITY.EXACT };

    case FIELD_KIND.ADF:
      // We have plain text, not ADF. Wrap it in a minimal document so the
      // shape is right and the diff engine has something to work with, and
      // grade it honestly. A reviewer looking at a RECONSTRUCTED description
      // is told, in the panel, that formatting may not be exact.
      return {
        value: first.fromString == null ? null : textToAdf(first.fromString),
        fidelity: FIDELITY.RECONSTRUCTED
      };

    case FIELD_KIND.SCALAR:
      // `from` is the id, `fromString` the display text. Prefer the id: ids are
      // stable and are what a restore has to write, display text is neither.
      return { value: first.from ?? first.fromString ?? null, fidelity: FIDELITY.EXACT };

    case FIELD_KIND.MULTI: {
      // Jira renders multi-values as a comma-separated string. `from` carries
      // ids for entity-backed fields (components, versions) and is absent for
      // labels, so take whichever is present and split it.
      const source = first.from ?? first.fromString;
      if (source == null || String(source).trim() === '') {
        return { value: [], fidelity: FIDELITY.EXACT };
      }
      return {
        value: String(source).split(',').map((s) => s.trim()).filter(Boolean).sort(),
        fidelity: FIDELITY.EXACT
      };
    }

    default:
      return { value: currentValue, fidelity: FIDELITY.PARTIAL };
  }
}

/** A minimal ADF document wrapping plain text, one paragraph per line. */
export function textToAdf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => (
      line.length === 0
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] }
    ))
  };
}

/**
 * Rewind controlled fields to transitionAt without I/O or a clock.
 * The caller supplies freshly read fields and changelog entries.
 *
 * @param issueFields fields from GET /issue/{key}.
 * @param controlledFields [{ field_id, field_kind, store_values, … }].
 * @param changelogEntries Entries from lib/changelog.js#fetchChangelog.
 * @param transitionAt Epoch milliseconds of the gated transition.
 * @param changelogFailed True when the changelog could not be read.
 */
export function rewind({ issueFields, controlledFields, changelogEntries = [], transitionAt, changelogFailed = false }) {
  const post = changelogEntries.filter((e) => e.at > transitionAt);

  // If nothing changed after the transition, the fresh read is the approved state.
  if (post.length === 0 && !changelogFailed) {
    return { fields: issueFields, perField: {}, fidelity: FIDELITY.EXACT, rewoundFields: [] };
  }

  // The changelog is the only thing that could tell us what happened in the
  // window, and we could not read it. We do not know whether anything changed,
  // so we must not claim the read is the approved state.
  if (changelogFailed) {
    return {
      fields: issueFields,
      perField: {},
      fidelity: FIDELITY.PARTIAL,
      rewoundFields: [],
      reason: 'CHANGELOG_UNAVAILABLE'
    };
  }

  const byField = {};
  for (const entry of post) {
    for (const item of entry.items) {
      (byField[item.fieldId] ??= []).push(item);
    }
  }

  const fields = { ...issueFields };
  const perField = {};
  const rewoundFields = [];
  const grades = [FIDELITY.EXACT];

  for (const cf of controlledFields) {
    const items = byField[cf.field_id];
    if (!items || items.length === 0) {
      perField[cf.field_id] = FIDELITY.EXACT;
      continue;
    }
    const { value, fidelity } = rewindField(cf.field_kind, issueFields?.[cf.field_id], items);
    if (fidelity !== FIDELITY.PARTIAL) {
      fields[cf.field_id] = value;
      rewoundFields.push(cf.field_id);
    }
    perField[cf.field_id] = fidelity;
    grades.push(fidelity);
  }

  return { fields, perField, fidelity: worstFidelity(grades), rewoundFields };
}

/**
 * Everything a baseline row needs, computed from an already-read issue.
 *
 * PURE, like rewind(). The caller does the I/O; this decides what to store.
 *
 * `writable` comes from the issue's editmeta and is recorded per field because
 * it is exactly the set a future restore can put back. Knowing it now is what
 * lets the admin console warn "this field is read-only and could never be
 * restored" at configuration time instead of the reviewer discovering it
 * halfway through a rejection.
 */
export function planCapture({
  issueId,
  issueKey,
  projectId,
  issueTypeId,
  version,
  controlledFields,
  issueFields,
  editmetaFields = {},
  transitionAt,
  capturedAt,
  actorId,
  actorName,
  transitionId = null,
  fromStatusId = null,
  toStatusId = null,
  requiredRole = null,
  requiredAssurance = null,
  assuranceLevel = null,
  approvalId = null,
  linkPolicy = null,
  changelogEntries = [],
  changelogFailed = false
}) {
  const rewound = rewind({
    issueFields,
    controlledFields,
    changelogEntries,
    transitionAt,
    changelogFailed
  });

  const { contentHash, digests, values, raw } = project(rewound.fields, controlledFields, { linkPolicy,
    issue: { id: issueId, fields: { ...rewound.fields, project: { id: projectId }, issuetype: { id: issueTypeId } } } });

  const writable = {};
  for (const cf of controlledFields) {
    // Absence from editmeta means Jira would not accept a write to this field
    // on this screen. Recorded as false rather than null: "we asked and it is
    // not editable" is a real answer, and a null here would make the admin
    // console show "unknown" for every field on a project whose editmeta we
    // read perfectly well.
    writable[cf.field_id] = Object.prototype.hasOwnProperty.call(editmetaFields, cf.field_id);
  }

  return {
    baseline: {
      issue_id: issueId,
      issue_key: issueKey,
      project_id: projectId,
      issue_type_id: issueTypeId,
      version,
      state: 'ACTIVE',
      content_hash: contentHash,
      field_digests: JSON.stringify(digests),
      transition_id: transitionId,
      from_status_id: fromStatusId,
      to_status_id: toStatusId,
      required_role: requiredRole,
      required_assurance: requiredAssurance,
      controlled_fields_hash: controlledFieldsHash(controlledFields, writable),
      approved_by: actorId,
      approved_name: actorName,
      transition_at: transitionAt,
      captured_at: capturedAt,
      assurance_level: assuranceLevel,
      approval_id: approvalId,
      fidelity: rewound.fidelity,
      field_count: controlledFields.length
      ,...(serialiseLinkPolicy(linkPolicy) ? { link_policy: serialiseLinkPolicy(linkPolicy) } : {})
    },
    digests,
    values,
    raw,
    writable,
    perFieldFidelity: rewound.perField,
    rewoundFields: rewound.rewoundFields
  };
}
import { serialiseLinkPolicy } from './linkPolicy.js';
