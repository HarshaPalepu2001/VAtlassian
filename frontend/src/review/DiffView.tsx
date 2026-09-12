import React, { useState } from 'react';
import { MaterialityBadge, When } from '../ui/feedback';
import { Badge } from '../ui/primitives';
import type { ReactNode } from 'react';
import type { DiffField, DiffOp, DiffBlock, DiffItem, MarkChange } from './types';
const IconArrowRight = () => <span aria-hidden>→</span>;
const IconRemove = () => <span aria-hidden>−</span>;
const IconAdd = () => <span aria-hidden>+</span>;
const IconRefresh = () => <span aria-hidden>↻</span>;

/**
 * The diff.
 *
 * Three ideas, in priority order:
 *
 *   1. A reviewer scanning this should be able to skip a field in under a
 *      second. Material changes open by default; cosmetic ones stay one line.
 *   2. Every change carries WHO and WHEN inline, not in a separate activity
 *      tab. "Who did this" is the second question a reviewer asks and making
 *      them go somewhere else for it is what turns a diff tool into a chore.
 *   3. Nothing is rendered as an empty value that is really a missing one. A
 *      field whose contents were never retained says so.
 */

export default function DiffView({ fields, focusDriftId }: {fields: DiffField[]; focusDriftId?: string}) {
  if (!fields || fields.length === 0) {
    return <div className="va-muted">No fields have changed since this work item was approved.</div>;
  }

  return (
    <div className="va-ledger">
      {fields.map((field) => (
        <FieldDiff
          key={field.fieldId}
          field={field}
          focused={!!focusDriftId && (field.driftIds ?? []).includes(focusDriftId)}
        />
      ))}
    </div>
  );
}

function FieldDiff({ field, focused }: {field: DiffField;focused: boolean}) {
  // Material changes open, formatting-only closed. That single default is most
  // of the panel's usability: the reviewer's eye lands on what needs deciding.
  const [open, setOpen] = useState(Boolean(field.semanticChange && field.materiality !== 'COSMETIC'));

  // A citation chip in the AI report was clicked and it points here. Open and
  // flash, so the claim and its evidence are visibly the same thing.
  React.useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);

  const rowClass = [
    'va-ledger__row',
    `va-ledger__row--${field.materiality ?? 'COSMETIC'}`,
    focused ? 'va-highlight' : ''
  ].filter(Boolean).join(' ');

  return (
    <div id={`field-${field.fieldId}`} className={rowClass}>
      <button
        type="button"
        className="va-ledger__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="va-ledger__name">{field.fieldName}</span>
        {/* The one-line index entry. Only shown while collapsed — once the row
            is open the values themselves are right there, and repeating them
            in prose above is the kind of label that says nothing twice. */}
        {!open && <span className="va-ledger__meta va-grow">{headline(field)}</span>}
        {open && <span className="va-grow" />}
        {field.retained === false && <Badge tone="neutral">value not kept</Badge>}
        {field.restorable === 'NO' && <Badge tone="neutral">cannot revert</Badge>}
        <MaterialityBadge level={field.materiality} />
        {/* A disclosure marker, not the word "Hide" repeated down the column.
            The button already carries aria-expanded, so the glyph is decoration
            for the eye and the state is announced properly regardless. */}
        <span className={open ? 'va-ledger__toggle va-ledger__toggle--open' : 'va-ledger__toggle'} aria-hidden />
      </button>
      {open && (
        <div className="va-ledger__body">
          <Body field={field} />
          <Attribution field={field} />
        </div>
      )}
    </div>
  );
}

/** The collapsed row's single line: the change itself, in the reader's words. */
function headline(field: DiffField): string {
  if (field.retained === false) return 'Changed — approved value was not kept';
  if (field.kind === 'multi' || field.kind === 'links' || field.kind === 'attachments') {
    const added = (field.added ?? []).length;
    const removed = (field.removed ?? []).length;
    const parts = [];
    if (added) parts.push(`${added} added`);
    if (removed) parts.push(`${removed} removed`);
    return parts.length ? parts.join(', ') : 'Changed';
  }
  if (field.kind === 'adf' || field.kind === 'text') return 'Text edited';
  const before = display(field, field.before);
  const after = display(field, field.after);
  return `${before.text} to ${after.text}`;
}

function Body({ field }: {field: DiffField}) {
  // THE HONEST DEGRADATION. The digest proves this field changed, but its
  // contents were never stored, so there is no before to show. Saying so is the
  // truthful consequence of per-field retention — rendering an empty diff would
  // read as "nothing really changed", which is a different and false claim.
  if (field.retained === false) {
    return (
      <div className="va-banner va-banner-warn">
        This field changed, but VAtlassian does not retain its contents, so the previous
        value cannot be shown or written back. An administrator can turn retention on
        for it — that applies from the next approval onward.
      </div>
    );
  }

  switch (field.kind) {
    case 'adf': return <AdfDiff blocks={field.blocks} />;
    case 'text': return <InlineDiff ops={field.ops} />;
    case 'multi': return <SetDiff field={field} added={field.added} removed={field.removed} />;
    case 'links': return <LinkDiff field={field} />;
    case 'attachments': return <AttachmentDiff field={field} />;
    default: return <ScalarDiff field={field} />;
  }
}

/**
 * Rich text, block by block.
 *
 * The block structure is what makes a long description readable: unchanged
 * paragraphs are dimmed and skimmable, edited ones show word-level changes in
 * place, and a moved paragraph is one row rather than a deletion and an
 * insertion twenty lines apart.
 */
function AdfDiff({ blocks }: {blocks?: DiffBlock[]}) {
  if (!blocks || blocks.length === 0) return <div className="va-muted">No visible change.</div>;

  // Long unchanged stretches are collapsed to a single line. A reviewer reading
  // a diff of a 900-word description does not want to scroll through the 850
  // words nobody touched to find the two that changed.
  const rendered: ReactNode[] = [];
  let equalRun = 0;

  blocks.forEach((block, i) => {
    if (block.op === 'equal') { equalRun++; return; }
    if (equalRun > 0) {
      rendered.push(<Unchanged key={`eq-${i}`} count={equalRun} />);
      equalRun = 0;
    }
    rendered.push(<Block key={i} block={block} />);
  });
  if (equalRun > 0) rendered.push(<Unchanged key="eq-end" count={equalRun} />);

  return <div className="va-diff-text">{rendered}</div>;
}

function Unchanged({ count }: {count:number}) {
  return (
    <div className="va-block va-block-equal va-subtlest" style={{ fontStyle: 'italic' }}>
      {count} unchanged {count === 1 ? 'paragraph' : 'paragraphs'}
    </div>
  );
}

function Block({ block }: {block:DiffBlock}) {
  switch (block.op) {
    case 'insert':
      return <div className="va-block va-block-insert">{block.after?.text}</div>;
    case 'delete':
      return <div className="va-block va-block-delete">{block.before?.text}</div>;
    case 'modified':
      return (
        <div className="va-block va-block-modified">
          <InlineDiff ops={block.ops} />
          {block.markChange && <MarkNote change={block.markChange} />}
        </div>
      );
    case 'move':
      return (
        <div className="va-block va-block-move">
          <span className="va-subtlest">moved · </span>{block.after?.text}
        </div>
      );
    case 'markOnly':
      return (
        <div className="va-block va-block-markonly">
          {block.after?.text}
          <MarkNote change={block.markChange} />
        </div>
      );
    default:
      return null;
  }
}

/**
 * "Same words, now a link."
 *
 * Shown as a note rather than as a diff because it IS the whole finding — and
 * because reporting it as delete-plus-insert of identical text is exactly the
 * noise that makes people stop reading diffs.
 */
function MarkNote({ change }: {change?:MarkChange}) {
  if (!change) return null;
  const added = (change.to ?? []).filter((m) => !(change.from ?? []).includes(m));
  const removed = (change.from ?? []).filter((m) => !(change.to ?? []).includes(m));
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div className="va-subtlest" style={{ marginTop: 4 }}>
      Formatting: {added.map((m) => `+${m}`).concat(removed.map((m) => `−${m}`)).join(', ')}
    </div>
  );
}

function InlineDiff({ ops }: {ops?:DiffOp[]}) {
  if (!ops || ops.length === 0) return <span className="va-muted">No visible change.</span>;
  return (
    <span>
      {ops.map((op, i) => {
        if (op.op === 'insert') return <ins key={i} className="va-ins">{op.text}</ins>;
        if (op.op === 'delete') return <del key={i} className="va-del">{op.text}</del>;
        return <span key={i}>{op.text}</span>;
      })}
    </span>
  );
}

/**
 * The before/after pair.
 *
 * THE BUG THIS FIXES: it rendered "10000 → 3". Those are Jira's priority ids,
 * because the comparison runs on normalised values and normalising a scalar
 * keeps the identifier. Nobody can review that. The name now leads.
 *
 * The identifier is still printed underneath, and that is deliberate rather
 * than leftover: the signed baseline holds the identifier, so it is the thing
 * an auditor is actually looking at. Showing the name alone would be a nicer
 * screen making a weaker claim.
 */
function ScalarDiff({ field }: {field: DiffField}) {
  const before = display(field, field.before);
  const after = display(field, field.after);
  return (
    <div className="va-change">
      <Chip side="was" value={before} />
      <span className="va-flow" aria-hidden><IconArrowRight /></span>
      <Chip side="now" value={after} />
    </div>
  );
}

function Chip({ side, value }: {side:'was'|'now'; value:{text:string;id?:string}}) {
  return (
    <span className={`va-chip va-chip--${side === 'was' ? 'before' : 'after'}`}>
      <span className="va-chip__side">{side}</span>
      <span className="va-chip__value">{value.text}</span>
      {value.id && <span className="va-chip__id">id {value.id}</span>}
    </span>
  );
}

function SetDiff({ field, added = [], removed = [] }: {field:DiffField;added?:DiffItem[];removed?:DiffItem[]}) {
  return (
    <div className="va-pill-change">
      {removed.map((item, i) => (
        <span key={`r-${i}`} className="va-pill va-pill-before"><IconRemove /> {display(field, item).text}</span>
      ))}
      {added.map((item, i) => (
        <span key={`a-${i}`} className="va-pill va-pill-after"><IconAdd /> {display(field, item).text}</span>
      ))}
      {added.length === 0 && removed.length === 0 && <span className="va-muted">No change.</span>}
    </div>
  );
}

function LinkDiff({ field }: {field:DiffField}) {
  return (
    <>
      <div className="va-pill-change">
        {(field.removed ?? []).map((l, i) => (
          <span key={`r${i}`} className="va-pill va-pill-before"><IconRemove /> {describeLink(l, field)}</span>
        ))}
        {(field.added ?? []).map((l, i) => (
          <span key={`a${i}`} className="va-pill va-pill-after"><IconAdd /> {describeLink(l, field)}</span>
        ))}
      </div>
      <div className="va-subtlest" style={{ marginTop: 8 }}>
        Rejecting these changes restores the approved links, subject to Jira permissions.
        The restore result verifies the complete set afterward.
      </div>
    </>
  );
}

function AttachmentDiff({ field }: {field:DiffField}) {
  return (
    <>
      <div className="va-pill-change">
        {(field.removed ?? []).map((a, i) => (
          <span key={`r${i}`} className="va-pill va-pill-before"><IconRemove /> {typeof a === 'string' ? a : a.filename}</span>
        ))}
        {(field.added ?? []).map((a, i) => (
          <span key={`a${i}`} className="va-pill va-pill-after"><IconAdd /> {typeof a === 'string' ? a : a.filename}</span>
        ))}
        {(field.replaced ?? []).map((a, i) => (
          <span key={`x${i}`} className="va-pill"><IconRefresh /> {typeof a === 'string' ? a : a.filename} (same name, different file)</span>
        ))}
      </div>
      {(field.removed ?? []).length > 0 && (
        <div className="va-subtlest" style={{ marginTop: 8 }}>
          Deleted attachments cannot be re-uploaded by an app. Ask whoever removed them to add them back.
        </div>
      )}
    </>
  );
}

/**
 * WHO, WHEN, AND HOW MANY TIMES — inline, under every change.
 *
 * This is the difference between a diff tool and a traceability tool. "Priority
 * went from High to Highest" is a diff. "Raised by Automation for Jira, lowered
 * by Priya, raised again by Sam, nine days after approval" is something a
 * reviewer can act on — and it is only knowable by joining the changelog to the
 * value comparison, which is what the backend does.
 */
function Attribution({ field }: {field:DiffField}) {
  const trail = field.attribution ?? [];
  if (trail.length === 0) {
    return (
      <div className="va-trace">
        <span className="va-subtlest">
          Jira did not record who made this change — it may have been an import, a bulk
          edit, or a project type that does not keep field history.
        </span>
      </div>
    );
  }

  return (
    <div className="va-trace">
      <div className="va-row" style={{ marginBottom: 2 }}>
        <span className="va-trace__title">
          Changed {trail.length === 1 ? 'once' : `${trail.length} times`} since approval
        </span>
        {field.churned && <Badge tone="neutral">ended where it started</Badge>}
      </div>
      {/* Name left, time right. Five edits should read as a column of dates a
          reviewer can scan, not five sentences they have to parse. */}
      {trail.map((t, i) => (
        <div className="va-trace-row" key={`${t.at}-${i}`}>
          <span className="va-grow va-truncate">
            {t.authorName ?? t.authorId ?? 'Unknown'}
            {t.detected && <span className="va-muted"> · seen by VAtlassian, not in Jira history</span>}
            {t.source === 'AUTOMATION' && <Badge tone="neutral">automation</Badge>}
            {t.source === 'APP' && <Badge tone="neutral">app</Badge>}
            {t.source === 'BASELINE' && <Badge tone="brand">restore</Badge>}
          </span>
          <When ms={t.at} />
        </div>
      ))}
    </div>
  );
}

function describeLink(l: DiffItem, field?: DiffField) {
  if (!l) return 'link';
  if (typeof l === 'string') return l;
  const labels = field?.valueLabels;
  const typeId = l.type ? String(l.type) : '';
  const typeName = (labels && labels[typeId]) || l.type || 'Link';
  const targetId = l.inward ? String(l.inward) : (l.outward ? String(l.outward) : '');
  const targetName = (labels && labels[targetId]) || targetId;
  if (typeName && targetName) {
    return `${typeName}: ${targetName}`;
  }
  return `${typeName || 'Link'} ${targetName}`.trim();
}

/**
 * One value, resolved for reading.
 *
 * Returns the display name and — only when the two genuinely differ — the
 * stored identifier behind it, so the caller can show both. `valueLabels` is
 * built by the backend from the raw values on both sides of the comparison,
 * which is the only place a name survives normalisation.
 *
 * An identifier with no known name renders as itself. That is the honest
 * outcome: an invented label would be worse than a bare id, because the reader
 * could not tell it was invented.
 */
function display(field: DiffField, v: unknown): { text: string; id?: string } {
  if (v === null || v === undefined) return { text: 'Empty' };
  if (Array.isArray(v)) {
    if (v.length === 0) return { text: 'Empty' };
    return { text: v.map((item) => display(field, item).text).join(', ') };
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const name = o.name ?? o.displayName ?? o.value ?? o.filename;
    if (name != null) return { text: String(name) };
    const id = o.accountId ?? o.id ?? o.key;
    return id == null ? { text: 'A structured value' } : display(field, id);
  }

  const raw = String(v);
  if (raw.length === 0) return { text: 'Empty' };
  const name = field.valueLabels?.[raw];
  if (!name) return { text: raw };
  return referenceable(raw) ? { text: name, id: raw } : { text: name };
}

/**
 * Whether an identifier is one a person can actually use as a reference.
 *
 * A Jira entity id — priority 10000, status 3, an option id — is a real
 * reference: it is what the signed baseline stores and what an auditor would
 * quote. An Atlassian account id is not. It identifies a *person*, means
 * nothing to the reader, and printing it beside their name is a disclosure with
 * no corresponding benefit — the rule ui/format.ts exists to enforce.
 *
 * Numeric-only, and short. That admits the entity ids and excludes account ids
 * in both their shapes ("5b10a2844c20165700ede21g" and "712020:8a3f11c2").
 */
function referenceable(id: string): boolean {
  return /^[0-9]{1,12}$/.test(id);
}
