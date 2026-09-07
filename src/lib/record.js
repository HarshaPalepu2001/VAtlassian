import { FIELD_KIND } from './content.js';

/**
 * THE BASELINE RECORD — what a work item looks like when there is nothing to do.
 *
 * A baselined item spends almost all of its life clean, and the panel's answer
 * to that state was a single green sentence: "All good. Unchanged since it was
 * approved by X." True, and it made the app invisible for the ninety-odd
 * percent of the time that nothing is wrong. Worse, it made the app
 * unfalsifiable — a reviewer had no way to see WHAT was being watched, so
 * "unchanged" was a claim they had to take on faith about a set of fields they
 * could not enumerate.
 *
 * That is the wrong shape for a compliance tool. The clean state is exactly
 * where the audit belongs: which fields are tracked, what their approved values
 * are, which of them have their contents retained and which only have a digest,
 * who approved them, on what edge, and at what assurance. All of it is already
 * in the database at the moment the panel renders; none of it was being shown.
 *
 * PURE, AND SEPARATE FROM THE RESOLVER, for the reason every lib/ module here
 * is: this is the part with rules in it — what counts as a preview, how a
 * non-retained field is described, how long is too long — and rules that can
 * only be exercised by standing up Forge SQL do not get exercised.
 */

/** How much of a value to show before it stops being a preview. */
const PREVIEW_CHARS = 240;

/** How many members of a multi-valued field to name before summarising. */
const PREVIEW_ITEMS = 8;

/**
 * Flatten ADF to readable text.
 *
 * NOT A RENDERER. The record shows what a field CONTAINED, so a reviewer can
 * confirm the approved value is the one they remember; it is not trying to
 * reproduce Jira's formatting. Rendering rich text properly is DiffView's job
 * and it needs the whole node tree to do it — which is precisely why this
 * returns a preview and the full comparison lives on the diff path.
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
  return { text: (space > PREVIEW_CHARS - 40 ? cut.slice(0, space) : cut), truncated: true };
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
      // Link targets are immutable numeric ids by design (see normaliseLinks —
      // issue KEYS change when an item moves project). An id is not readable,
      // so the preview counts them rather than pretending to name them.
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
