import React, { useState } from 'react';
import { MaterialityBadge, When, Collapsible } from '../ui/feedback';
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
    <div className="va-stack">
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

  const header = (
    <>
      <span className="va-grow va-truncate">
        <strong>{field.fieldName}</strong>
        <span className="va-muted" style={{ marginLeft: 8 }}>{field.summary}</span>
      </span>
      {field.retained === false && <Badge tone="neutral">not retained</Badge>}
      {field.restorable === 'NO' && <Badge tone="neutral">cannot revert</Badge>}
      <MaterialityBadge level={field.materiality} />
    </>
  );

  return (
    <div
      id={`field-${field.fieldId}`}
      className={focused ? 'va-highlight' : undefined}
      style={{ borderRadius: 'var(--va-radius-lg)' }}
    >
      <Collapsible open={open} onToggle={() => setOpen((v) => !v)} header={header}>
        <Body field={field} />
        <Attribution field={field} />
      </Collapsible>
    </div>
  );
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
    case 'multi': return <SetDiff added={field.added} removed={field.removed} />;
    case 'links': return <LinkDiff field={field} />;
    case 'attachments': return <AttachmentDiff field={field} />;
    default: return <ScalarDiff before={field.before} after={field.after} />;
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

function ScalarDiff({ before, after }: {before:unknown;after:unknown}) {
  return (
    <div className="va-pill-change">
      <span className="va-pill va-pill-before">{label(before)}</span>
      <span className="va-arrow" aria-hidden style={{ display: 'inline-flex', alignItems: 'center' }}><IconArrowRight /></span>
      <span className="va-pill va-pill-after">{label(after)}</span>
    </div>
  );
}

function SetDiff({ added = [], removed = [] }: {added?:DiffItem[];removed?:DiffItem[]}) {
  return (
    <div className="va-pill-change">
      {removed.map((item) => (
        <span key={`r-${item}`} className="va-pill va-pill-before" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconRemove /> {label(item)}</span>
      ))}
      {added.map((item) => (
        <span key={`a-${item}`} className="va-pill va-pill-after" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAdd /> {label(item)}</span>
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
          <span key={`r${i}`} className="va-pill va-pill-before" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconRemove /> {describeLink(l)}</span>
        ))}
        {(field.added ?? []).map((l, i) => (
          <span key={`a${i}`} className="va-pill va-pill-after" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAdd /> {describeLink(l)}</span>
        ))}
      </div>
      <div className="va-subtlest" style={{ marginTop: 8 }}>
        Issue links are listed but not reverted automatically — deleting a link somebody
        made deliberately is a different act from resetting a field value.
      </div>
    </>
  );
}

function AttachmentDiff({ field }: {field:DiffField}) {
  return (
    <>
      <div className="va-pill-change">
        {(field.removed ?? []).map((a) => (
          <span key={`r${label(a)}`} className="va-pill va-pill-before" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconRemove /> {typeof a === 'string' ? a : a.filename}</span>
        ))}
        {(field.added ?? []).map((a) => (
          <span key={`a${label(a)}`} className="va-pill va-pill-after" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAdd /> {typeof a === 'string' ? a : a.filename}</span>
        ))}
        {(field.replaced ?? []).map((a) => (
          <span key={`x${label(a)}`} className="va-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconRefresh /> {typeof a === 'string' ? a : a.filename} (same name, different file)</span>
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
      <div className="va-row" style={{ marginBottom: 4 }}>
        <strong style={{ fontSize: 12 }}>
          Changed {trail.length === 1 ? 'once' : `${trail.length} times`} since approval
        </strong>
        {field.churned && <Badge tone="neutral">ended where it started</Badge>}
      </div>
      {trail.map((t, i) => (
        <div className="va-trace-row" key={`${t.at}-${i}`}>
          <When ms={t.at} />
          <span className="va-grow va-truncate">
            {t.authorName ?? 'Unknown'}
            {t.source === 'AUTOMATION' && <Badge tone="neutral"> automation</Badge>}
            {t.source === 'APP' && <Badge tone="neutral"> app</Badge>}
            {t.source === 'BASELINE' && <Badge tone="brand"> Baseline restore</Badge>}
          </span>
        </div>
      ))}
    </div>
  );
}

function describeLink(l: DiffItem) {
  if (!l) return 'link';
  if (typeof l === 'string') return l;
  return `${l.type ?? 'link'} ${l.inward ?? l.outward ?? ''}`.trim();
}

function label(v: unknown) {
  if (v === null || v === undefined) return '(empty)';
  if (Array.isArray(v)) return v.length === 0 ? '(empty)' : v.join(', ');
  if (typeof v === 'object') return String((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).displayName ?? (v as Record<string, unknown>).id ?? '(set)');
  const s = String(v);
  return s.length === 0 ? '(empty)' : s;
}
