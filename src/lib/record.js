import { FIELD_KIND } from './content.js';

/**
 * Build the baseline record shown when an item has no pending action.
 *
 * Show tracked fields, approved values, value-retention status, approver,
 * transition and assurance level. An "unchanged" message alone does not tell a
 * reviewer which fields the baseline covers or let them inspect its contents.
 *
 * Keep preview rules, non-retained-field labels and length limits separate
 * from resolver I/O so tests can exercise them without Forge SQL.
 */

/** How much of a value to show before it stops being a preview. */
const PREVIEW_CHARS = 240;

/** How many members of a multi-valued field to name before summarising. */
const PREVIEW_ITEMS = 8;

/**
 * Flatten ADF to a preview of the approved content. DiffView renders the
 * full rich-text comparison from its node tree.
 */
export function adfText(node) {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(adfText).filter(Boolean).join(' ');
  if (typeof node !== 'object') return String(node);

  if (typeof node.text === 'string') return node.text;

  const inner = Array.isArray(node.content) ? node.content.map(adfText).filter(Boolean) : [];

  // Block-level nodes become separate lines so a description does not collapse
  // into one run-on sentence. Inline nodes join with a space.
  const block = node.type === 'paragraph' || node.type === 'heading'
    || node.type === 'listItem' || node.type === 'blockquote' || node.type === 'codeBlock';

  return inner.join(block ? '\n' : ' ');
}

function clip(text) {
  const trimmed = String(text ?? '').replace(/\n{3,}/g, '\n\n').trim();
  if (trimmed.length <= PREVIEW_CHARS) return { text: trimmed, truncated: false };
  // Cut on a word boundary where one is close by, so a preview does not end
  // mid-word for the sake of four characters.
  const cut = trimmed.slice(0, PREVIEW_CHARS);
  const space = cut.lastIndexOf(' ');
  return { text: (space >= PREVIEW_CHARS - 40 ? cut.slice(0, space) : cut), truncated: true };
}

/**
 * A short, honest description of one approved value.
 *
 * Returns `{ text, truncated, empty, items }`. `empty` is distinct from an
 * empty string: a field that was approved with no value is a fact worth
 * showing, and rendering it as blank space would read as a missing preview
 * rather than a deliberate emptiness.
 */
export function previewOf(kind, value) {
  if (value === null || value === undefined) return { text: null, truncated: false, empty: true };

  switch (kind) {
    case FIELD_KIND.ADF: {
      const text = adfText(value);
      if (text.trim().length === 0) return { text: null, truncated: false, empty: true };
      return { ...clip(text), empty: false };
    }

    case FIELD_KIND.TEXT: {
      if (String(value).trim().length === 0) return { text: null, truncated: false, empty: true };
      return { ...clip(value), empty: false };
    }

    case FIELD_KIND.MULTI: {
      const items = Array.isArray(value) ? value.map(String) : [String(value)];
      if (items.length === 0) return { text: null, truncated: false, empty: true, items: [] };
      const shown = items.slice(0, PREVIEW_ITEMS);
      return {
        text: shown.join(', '),
        truncated: items.length > shown.length,
        empty: false,
        items,
        // Named so the UI can say "and 4 more" rather than silently dropping
        // them, which would make the record look complete when it is not.
        more: items.length - shown.length
      };
    }

    case FIELD_KIND.ATTACHMENTS: {
      const list = Array.isArray(value) ? value : [];
      if (list.length === 0) return { text: null, truncated: false, empty: true, items: [] };
      const names = list.map((a) => a.filename || a.id || 'unnamed');
      const shown = names.slice(0, PREVIEW_ITEMS);
      return {
        text: shown.join(', '),
        truncated: names.length > shown.length,
        empty: false,
        items: names,
        more: names.length - shown.length
      };
    }

    case FIELD_KIND.LINKS: {
      const list = Array.isArray(value) ? value : [];
      if (list.length === 0) return { text: null, truncated: false, empty: true, items: [] };
      // Link targets use stable numeric ids because Jira keys change across
      // project moves. Count links in previews rather than displaying those ids.
      return {
        text: `${list.length} linked work item${list.length === 1 ? '' : 's'}`,
        truncated: false,
        empty: false,
        items: []
      };
    }

    case FIELD_KIND.SCALAR:
    default: {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (text.trim().length === 0) return { text: null, truncated: false, empty: true };
      return { ...clip(text), empty: false };
    }
  }
}


export function buildRecord({
  baseline, controlledFields = [], baselineValues = {}, digests = {}, approval = null
} = {}) {
  if (!baseline) return null;

  const fields = [...controlledFields]
    .sort((a, b) => String(a.field_name ?? '').localeCompare(String(b.field_name ?? '')))
    .map((field) => {
      const retained = field.store_values === true;
      const value = retained ? baselineValues[field.field_id] : undefined;

      return {
        fieldId: field.field_id,
        fieldName: field.field_name,
        kind: field.field_kind,
        materiality: field.materiality,
        retained,
        // Present for every field, retained or not. This is the thing that
        // actually detects drift, and showing it is what lets a reviewer verify
        // the record independently rather than trusting the panel's summary.
        digest: digests?.[field.field_id] ?? null,
        preview: retained ? previewOf(field.field_kind, value ?? null) : null
      };
    });

  return {
    version: baseline.version,
    approvedBy: baseline.approved_by ?? null,
    approvedName: baseline.approved_name ?? null,
    approvedAt: baseline.transition_at ?? baseline.captured_at ?? null,
    capturedAt: baseline.captured_at ?? null,
    fidelity: baseline.fidelity ?? null,
    contentHash: baseline.content_hash ?? null,
    fromStatusId: baseline.from_status_id ?? null,
    toStatusId: baseline.to_status_id ?? null,
    transitionId: baseline.transition_id ?? null,

    assurance: baseline.assurance_level ?? approval?.assurance_level ?? null,
    assuranceLevel: baseline.assurance_level ?? approval?.assurance_level ?? null,
    approvalId: baseline.approval_id?.toString('hex') ?? null,
    signedAt: approval?.signed_at ?? approval?.decided_at ?? null,

    fieldCount: fields.length,
    retainedCount: fields.filter((f) => f.retained).length,
    fields
  };
}
