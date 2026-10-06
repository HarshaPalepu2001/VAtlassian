import { useEffect, useRef, useState } from 'react';
import { MaterialityBadge, When } from '../ui/feedback';
import { Badge } from '../ui/primitives';
import { Avatar } from '../ui/brand';
import { formatTimestamp, relativeTime, sinceLabel } from '../ui/format';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Attribution as Step, DiffField, DiffOp, DiffBlock, DiffCell, DiffItem, MarkChange, ReviewGroup, StructureChange } from './types';
const IconArrowRight = () => <span aria-hidden>→</span>;
const IconRemove = () => <span aria-hidden>−</span>;
const IconAdd = () => <span aria-hidden>+</span>;

/**
 * The diff.
 *
 * Two panes. On the left, every change, listed the way a parent's decision
 * covers it: the parent's own fields, the structure (work items added,
 * removed or moved), then each drifted child's fields. On the right, the one
 * change picked there, in full.
 *
 * Three questions, answered on the list row before anyone clicks:
 *
 *   1. WHAT changed — the value, or for rich text what kind of edit, in one
 *      line.
 *   2. WHO and WHEN — the last editor and how long ago, with the exact time on
 *      hover, and how many edits it took. A reviewer triages on "Sam, two days
 *      ago, three edits" long before they read a value.
 *   3. HOW BAD — the row's spine, coloured by materiality.
 *
 * The detail then answers HOW IT GOT HERE: every edit in order, each with its
 * own from → to and its distance from the signature, so a date that moved
 * twice reads as two steps rather than one surprising jump. The reviewer lands
 * on the most severe change.
 *
 * Nothing is rendered as an empty value that is really a missing one. A field
 * whose contents were never retained says so.
 */

type Props = {
  fields: DiffField[];
  groups?: ReviewGroup[];
  mode?: 'drift' | 'versions';
  fromVersion?: number;
  toVersion?: number;
  incomplete?: boolean;
  focusDriftId?: string;
  /** A field picked from the timeline: selected and highlighted like a citation. */
  focusFieldId?: string;
  /** Bumped on every citation or timeline pick, so picking the same change twice still selects it. */
  focusKey?: number;
  /** When the baseline was signed: the origin every "+3 days" is measured from. */
  baselineAt?: number | null;
  /** The clock relative times are read against; tests pin it, callers omit it. */
  now?: number;
};

type Section = { key: string; title: string | null; version: number | null; fields: DiffField[] };

const SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR', 'COSMETIC'];
const severity = (field: DiffField) => {
  const rank = SEVERITY.indexOf(field.materiality ?? 'COSMETIC');
  return rank < 0 ? SEVERITY.length : rank;
};

export default function DiffView({ fields, groups, mode = 'drift', fromVersion, toVersion, incomplete = false, focusDriftId, focusFieldId, focusKey, baselineAt, now }: Props) {
  // A parent's review covers its children: one section per work item, each
  // child compared with its own latest baseline. The groups hold the same
  // fields as the flat list, so nothing is shown twice or left out.
  const grouped = Boolean(groups && groups.length > 0);
  const sections: Section[] = grouped
    ? groups!.map(group => ({
      key: group.kind === 'STRUCTURE' ? 'structure' : `issue-${group.issueKey}`,
      title: groupTitle(group),
      version: group.kind === 'ISSUE' ? group.baselineVersion ?? null : null,
      fields: group.fields
    }))
    : [{ key: 'all', title: null, version: null, fields: fields ?? [] }];
  const ordered = sections.flatMap(section => section.fields);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The change a citation or timeline pick pointed at flashes once; picking
  // another row by hand clears it.
  const [flashId, setFlashId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const focused = ordered.find(f => (!!focusFieldId && f.fieldId === focusFieldId)
    || (!!focusDriftId && (f.driftIds ?? []).includes(focusDriftId)));
  useEffect(() => {
    if (!focused) return;
    setSelectedId(focused.fieldId);
    setFlashId(focused.fieldId);
  }, [focused?.fieldId, focusKey]);

  // The first most severe change, until the reviewer picks one. A pick that
  // disappears on an evidence refresh falls back the same way.
  const selected = ordered.find(f => f.fieldId === selectedId)
    ?? ordered.reduce<DiffField | undefined>((best, f) => (!best || severity(f) < severity(best) ? f : best), undefined);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected?.fieldId]);

  if (!selected) {
    return <div className="va-muted">{mode === 'versions'
      ? incomplete ? 'No visible differences. This comparison is incomplete.' : 'These signed versions have the same tracked content.'
      : 'No fields have changed since this work item was approved.'}</div>;
  }

  const pick = (field: DiffField) => { setSelectedId(field.fieldId); setFlashId(null); };
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = ordered.indexOf(selected!);
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? ordered.length - 1 : null;
    if (next == null) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(ordered.length - 1, next));
    pick(ordered[index]);
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[index]?.focus();
  }

  return (
    <div className="va-review">
      <div ref={listRef} className="va-review__list" role="listbox" aria-label={mode === 'versions' ? 'Changes between signed versions' : 'Changes'} onKeyDown={onKeyDown}>
        {sections.map(section => (
          <div key={section.key} role="group" aria-label={section.title ?? 'Changes'} className="va-diff-group">
            {section.title && (
              <div className="va-diff-group__head">
                <span className="va-diff-group__title">{section.title}</span>
                {section.version != null && <span className="va-secondary">against version {section.version}</span>}
              </div>
            )}
            {section.fields.map(field => (
              <ChangeRow key={`${field.issueKey ?? ''}:${field.fieldId}`} field={field}
                // Inside its work item's section a field is named plainly.
                name={grouped ? field.label ?? field.fieldName : field.fieldName}
                selected={field === selected} onSelect={() => pick(field)} now={now} historical={mode === 'versions'} />
            ))}
          </div>
        ))}
      </div>
      <section className="va-review__detail" aria-label="Selected change">
        <FieldDetail key={selected.fieldId} field={selected} flash={flashId === selected.fieldId} baselineAt={baselineAt} now={now}
          historical={mode === 'versions'} fromVersion={fromVersion} toVersion={toVersion} />
      </section>
    </div>
  );
}

/** "KEY · summary" for a work item's section; the structure has its own heading. */
function groupTitle(group: ReviewGroup): string {
  if (group.kind === 'STRUCTURE') return 'Structure: work items added, removed or moved';
  return [group.issueKey, group.summary].filter(Boolean).join(' · ') || 'Work item';
}

/** "Sam Ortiz · 2 days ago · 3 edits", or nothing when no edit was recorded. */
function whoLine(field: DiffField, now?: number): { text: string; title?: string } | null {
  const last = lastEdit(field);
  if (!last) return null;
  const edits = Math.max(field.occurrences ?? 0, (field.attribution ?? []).filter(step => !step.detected).length);
  return {
    text: `${last.by ?? 'Someone'}${last.at ? ` · ${relativeTime(last.at, now)}` : ''}${edits > 1 ? ` · ${edits} edits` : ''}`,
    title: formatTimestamp(last.at) ?? undefined
  };
}

/** One line in the list: name, the change in a line, and who last touched it. */
function ChangeRow({ field, name, selected, onSelect, now, historical }: { field: DiffField; name: string; selected: boolean; onSelect: () => void; now?: number; historical?: boolean }) {
  const who = historical ? null : whoLine(field, now);
  return (
    <div role="option" aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={onSelect}
      className={`va-review__row va-review__row--${field.materiality ?? 'COSMETIC'}`}>
      <span className="va-review__row-name">{name}</span>
      <span className="va-review__row-what">{headline(field)}</span>
      {who && <span className="va-review__row-who" title={who.title}>{who.text}</span>}
    </div>
  );
}

/** The selected change in full: its values, then every edit that got it here. */
function FieldDetail({ field, flash, baselineAt, now, historical, fromVersion, toVersion }: { field: DiffField; flash: boolean; baselineAt?: number | null; now?: number; historical?: boolean; fromVersion?: number; toVersion?: number }) {
  const who = historical ? null : whoLine(field, now);
  return (
    <article id={`field-${field.fieldId}`} className={flash ? 'va-review__field va-highlight' : 'va-review__field'}>
      <header className="va-review__field-head">
        <h3 className="va-review__field-name">{field.fieldName}</h3>
        {field.retained === false && <Badge tone="neutral">value not kept</Badge>}
        {field.restorable === 'NO' && <Badge tone="neutral">cannot revert</Badge>}
        <MaterialityBadge level={field.materiality} />
      </header>
      {who && <div className="va-review__row-who" title={who.title}>Last changed by {who.text}</div>}
      {historical && field.scopeChange === 'ADDED' && <p className="va-secondary">First tracked in version {toVersion}. Version {fromVersion} has no signed value for this field.</p>}
      {historical && field.scopeChange === 'REMOVED' && <p className="va-secondary">Tracked in version {fromVersion}, then left the signed field set in version {toVersion}.</p>}
      <Body field={field} historical={historical} fromVersion={fromVersion} toVersion={toVersion} />
      {!historical && <Attribution field={field} baselineAt={baselineAt} />}
    </article>
  );
}


/** The latest edit — the backend's own figure first, the trail's last step otherwise. */
function lastEdit(field: DiffField): { at: number | null; by: string | null } | null {
  const trail = (field.attribution ?? []).filter(step => !step.detected);
  const tail = trail[trail.length - 1];
  const at = field.lastChangedAt ?? tail?.at ?? null;
  const by = field.lastChangedBy ?? tail?.authorName ?? null;
  if (at == null && by == null) return null;
  return { at: at == null ? null : Number(at), by };
}

/** The collapsed row's single line: the change itself, in the reader's words. */
export function headline(field: DiffField): string {
  if (field.scopeChange === 'ADDED') return field.retained === false ? 'Tracking added; value not retained' : 'Tracking added; first signed value shown';
  if (field.scopeChange === 'REMOVED') return 'Tracking ended after this version';
  if (field.scopeChange?.startsWith('NODE_')) return field.summary ?? 'Tree structure changed';
  if (field.retained === false) return 'Changed — approved value was not kept';
  if (field.kind === 'multi' || field.kind === 'links' || field.kind === 'attachments') {
    const added = (field.added ?? []).length;
    const removed = (field.removed ?? []).length;
    const parts = [];
    if (added) parts.push(`${added} added`);
    if (removed) parts.push(`${removed} removed`);
    return parts.length ? parts.join(', ') : 'Changed';
  }
  if (field.kind === 'adf') return blockSummary(field.blocks) ?? 'Text edited';
  if (field.kind === 'text') return 'Text edited';
  const before = display(field, field.before);
  const after = display(field, field.after);
  return `${before.text} → ${after.text}`;
}

/**
 * "1 paragraph edited, 1 added" — what kind of edit a rich-text field took,
 * counted from the same blocks the body draws. Table rows are counted as rows,
 * because "3 paragraphs added" for a new table is true and misleading.
 */
function blockSummary(blocks?: DiffBlock[]): string | null {
  if (!blocks || blocks.length === 0) return null;
  const tally = new Map<string, number>();
  let unit = 'paragraph';
  for (const block of blocks) {
    const verb = block.op === 'insert' ? 'added' : block.op === 'delete' ? 'removed' : block.op === 'move' ? 'moved'
      : block.op === 'markOnly' ? 'reformatted' : block.op === 'modified' || block.op === 'structure' ? 'edited' : null;
    if (!verb) continue;
    if (tableIdOf(block) != null) unit = 'row';
    tally.set(verb, (tally.get(verb) ?? 0) + 1);
  }
  if (tally.size === 0) return null;
  const order = ['edited', 'added', 'removed', 'moved', 'reformatted'].filter(v => tally.has(v));
  return order.map((verb, i) => {
    const n = tally.get(verb)!;
    return i === 0 ? `${n} ${n === 1 ? unit : `${unit}s`} ${verb}` : `${n} ${verb}`;
  }).join(', ');
}

function Body({ field, historical, fromVersion, toVersion }: {field: DiffField; historical?: boolean; fromVersion?: number; toVersion?: number}) {
  // THE HONEST DEGRADATION. The digest proves this field changed, but its
  // contents were never stored, so there is no before to show. Saying so is the
  // truthful consequence of per-field retention — rendering an empty diff would
  // read as "nothing really changed", which is a different and false claim.
  if (field.retained === false) {
    return (
      <div className="va-banner va-banner-warn">
        {historical
          ? 'One or both signed versions kept only a digest for this field. Its contents cannot be compared here.'
          : 'This field changed, but VAtlassian does not retain its contents, so the previous value cannot be shown or written back. An administrator can turn retention on for it — that applies from the next approval onward.'}
      </div>
    );
  }

  switch (field.kind) {
    case 'adf': return <AdfDiff blocks={field.blocks} />;
    case 'text': return <InlineDiff ops={field.ops} />;
    case 'multi': return <SetDiff field={field} added={field.added} removed={field.removed} />;
    case 'links': return <LinkDiff field={field} historical={historical} />;
    case 'attachments': return <AttachmentDiff field={field} historical={historical} />;
    default: return <ScalarDiff field={field} beforeLabel={historical ? `Version ${fromVersion}` : undefined} afterLabel={historical ? `Version ${toVersion}` : undefined} />;
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
  let i = 0;

  const flushEqual = (key: string | number) => {
    if (equalRun === 0) return;
    rendered.push(<Unchanged key={`eq-${key}`} count={equalRun} />);
    equalRun = 0;
  };

  while (i < blocks.length) {
    const block = blocks[i];

    // A TABLE IS DRAWN AS A TABLE. The backend emits one block per row, tagged
    // with the table it came from, so consecutive rows of the same table are
    // collected here and rendered as one grid. Unchanged rows are kept inside
    // it — a table missing the rows nobody touched is not a table any more,
    // and the reviewer loses the column headings that make the rest legible.
    const id = tableIdOf(block);
    if (id != null) {
      const run: DiffBlock[] = [];
      while (i < blocks.length && tableIdOf(blocks[i]) === id) run.push(blocks[i++]);
      if (run.every((r) => r.op === 'equal')) { equalRun += run.length; continue; }
      flushEqual(i);
      rendered.push(<TableDiff key={`table-${i}`} rows={run} />);
      continue;
    }

    if (block.op === 'equal') { equalRun++; i++; continue; }
    flushEqual(i);
    rendered.push(<Block key={i} block={block} />);
    i++;
  }
  flushEqual('end');

  return <div className="va-diff-text">{rendered}</div>;
}

/** The table a row belongs to, or null when this block is not a table row. */
function tableIdOf(block?: DiffBlock): string | null {
  const side = block?.after ?? block?.before;
  if (!side || side.type !== 'tableRow') return null;
  return side.tableId ?? 'table';
}

/**
 * One table, before and after.
 *
 * Row colour carries the whole story — a green row was added, a struck red one
 * was removed, an amber one was edited and shows the change inside the cell
 * that changed. That is the same vocabulary the rest of this diff already uses,
 * applied to a grid, which is why this needed no new legend.
 */
function TableDiff({ rows }: {rows: DiffBlock[]}) {
  const changed = rows.filter((r) => r.op !== 'equal');
  const every = (op: string) => changed.length > 0 && changed.every((r) => r.op === op);
  const caption = every('insert') ? 'Added' : every('delete') ? 'Removed' : 'Edited';

  return (
    <div className="va-block va-block-table">
      <div className="va-subtlest va-table-caption">{caption}</div>
      {/* A table's own attrs (layout, row numbers) show on every row; say it once. */}
      <StructureNote changes={[...new Map(rows.flatMap((r) => r.structureChange ?? []).map((c) => [c.text, c])).values()]} />
      <table className="va-diff-table">
        <tbody>
          {rows.map((row, i) => <TableRowDiff key={i} row={row} />)}
        </tbody>
      </table>
    </div>
  );
}

function TableRowDiff({ row }: {row: DiffBlock}) {
  const op = row.op === 'markOnly' || row.op === 'move' ? 'equal' : row.op === 'structure' ? 'modified' : row.op;
  const side = op === 'delete' ? row.before : (row.after ?? row.before);

  // `cells` is only present on an edited row, where the backend paired the
  // cells by position. Every other row shows its own cells as they stand.
  const cells: DiffCell[] = row.cells ?? (side?.cells ?? []).map((c) => ({
    op, before: c.text ?? '', after: c.text ?? '', header: c.header, ops: []
  }));

  return (
    <tr className={`va-diff-table__row va-diff-table__row--${op}`}>
      {cells.map((cell, i) => {
        const Cell = cell.header ? 'th' : 'td';
        return (
          <Cell key={i} className={`va-diff-table__cell va-diff-table__cell--${cell.op}`}>
            <CellBody cell={cell} rowOp={op} />
          </Cell>
        );
      })}
    </tr>
  );
}

function CellBody({ cell, rowOp }: {cell: DiffCell; rowOp: string}) {
  if (cell.op === 'modified' && (cell.ops ?? []).length > 0) return <InlineDiff ops={cell.ops} />;
  // A cell a row gained or lost is named as such even when the row as a whole
  // was only edited, so "the Type column is new" does not read as "this row was
  // rewritten".
  if (cell.op === 'insert' && rowOp === 'modified') return <ins className="va-ins">{cell.after}</ins>;
  if (cell.op === 'delete' && rowOp === 'modified') return <del className="va-del">{cell.before}</del>;
  return <>{cell.op === 'delete' ? cell.before : (cell.after ?? cell.before)}</>;
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
          <StructureNote changes={block.structureChange} />
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
    // Same words, different structure. Drawn as an edited block, because it is
    // one: the words alone would read as "nothing changed here", which is the
    // failure this op exists to prevent.
    case 'structure':
      return (
        <div className="va-block va-block-modified">
          {block.after?.text ?? block.before?.text}
          <StructureNote changes={block.structureChange} />
          {block.markChange && <MarkNote change={block.markChange} />}
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
/**
 * "Checklist item (unticked) → Paragraph", "Panel type: warning → info".
 *
 * The backend writes these sentences, so the panel, the report and the AI
 * payload all say the same thing about the same change.
 */
function StructureNote({ changes }: {changes?: StructureChange[]}) {
  if (!changes || changes.length === 0) return null;
  return (
    <div className="va-subtlest" style={{ marginTop: 4 }}>
      Structure: {changes.map((c) => c.text).join(' · ')}
    </div>
  );
}

function MarkNote({ change }: {change?:MarkChange | null}) {
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
function ScalarDiff({ field, beforeLabel = 'Approved', afterLabel = 'Now' }: {field: DiffField; beforeLabel?: string; afterLabel?: string}) {
  const before = display(field, field.before);
  const after = display(field, field.after);
  return (
    <div className="va-change">
      <Chip side="was" value={before} label={beforeLabel} />
      <span className="va-flow" aria-hidden><IconArrowRight /></span>
      <Chip side="now" value={after} label={afterLabel} />
    </div>
  );
}

function Chip({ side, value, label }: {side:'was'|'now'; value:{text:string;id?:string}; label:string}) {
  return (
    <span className={`va-chip va-chip--${side === 'was' ? 'before' : 'after'}`}>
      <span className="va-chip__side">{label}</span>
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

function LinkDiff({ field, historical = false }: {field:DiffField; historical?: boolean}) {
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
      {!historical && <div className="va-subtlest" style={{ marginTop: 8 }}>
        Rejecting these changes restores the approved links, subject to Jira permissions.
        The restore result verifies the complete set afterward.
      </div>}
    </>
  );
}

function AttachmentDiff({ field, historical = false }: {field:DiffField; historical?: boolean}) {
  const file = (item: DiffItem, action: 'Added' | 'Removed', index: number) => {
    const details = typeof item === 'string' ? null : item;
    const name = details?.filename || details?.id || (typeof item === 'string' ? item : 'Unnamed file');
    const size = typeof details?.size === 'number' ? `${details.size < 1024 ? `${details.size} bytes` : `${Math.round(details.size / 1024)} KB`} (${new Intl.NumberFormat().format(details.size)} bytes)` : null;
    return <div key={`${action}-${details?.id ?? index}`} className={`va-file-change va-file-change--${action.toLowerCase()}`}>
      <div className="va-file-change__title"><strong>{action}: {name}</strong></div>
      <div className="va-file-change__facts">
        {size && <span>{size}</span>}
        {details?.mimeType && <span>{details.mimeType}</span>}
        {details?.authorName && <span>Uploaded by {details.authorName}</span>}
        {details?.created && <span>Uploaded {formatTimestamp(details.created) ?? details.created}</span>}
        {details?.id && <span>Audit ID {details.id}</span>}
        {details?.jiraId && <span>Current Jira ID {details.jiraId}</span>}
      </div>
    </div>;
  };
  return (
    <>
      <div className="va-file-changes">
        {(field.removed ?? []).map((a, i) => file(a, 'Removed', i))}
        {(field.added ?? []).map((a, i) => file(a, 'Added', i))}
      </div>
      {!historical && ((field.removed ?? []).length > 0 || (field.added ?? []).length > 0) && (
        <div className="va-subtlest" style={{ marginTop: 8 }}>
          Rejection can restore removed files from the vault and delete added files. The rejection review checks vault availability before any action.
        </div>
      )}
    </>
  );
}

/**
 * HOW IT GOT HERE — inline, under every change.
 *
 * This is the difference between a diff tool and a traceability tool. "Priority
 * went from High to Highest" is a diff. "Raised by Automation for Jira, lowered
 * by Priya, raised again by Sam, nine days after approval" is something a
 * reviewer can act on — and it is only knowable by joining the changelog to the
 * value comparison, which is what the backend does.
 *
 * Each step prints Jira's own from → to for that edit. Rich text is the
 * exception: Jira's history holds a flattened copy of the whole document, which
 * is noise, so those steps say "edited" and the block diff above carries the
 * net change. A change VAtlassian noticed without a matching Jira history entry
 * says so rather than inventing a before and after.
 */
function Attribution({ field, baselineAt }: {field:DiffField; baselineAt?: number | null}) {
  const trail = field.attribution ?? [];
  if (trail.length === 0) {
    return (
      <div className="va-trace">
        <span className="va-subtlest">
          {field.attributionStatus === 'NOT_COLLECTED'
            ? 'Detailed change history for descendant issues is not included in this root review.'
            : field.attributionStatus === 'UNAVAILABLE'
              ? 'Jira change history could not be loaded for this review. The value comparison remains available, but who and when is unknown.'
              : 'Jira did not record who made this change — it may have been an import, a bulk edit, or a project type that does not keep field history.'}
        </span>
      </div>
    );
  }

  const richText = field.kind === 'adf' || field.kind === 'text';
  return (
    <div className="va-trace">
      <div className="va-row" style={{ marginBottom: 2 }}>
        <span className="va-trace__title">How it got here · {trail.length} recorded {trail.length === 1 ? 'event' : 'events'} since approval</span>
        {field.churned && <Badge tone="neutral">ended where it started</Badge>}
      </div>
      <ol className="va-steps">
        {trail.map((t, i) => (
          <li className="va-step" key={`${t.at}-${i}`}>
            <span className="va-step__when">
              {t.detected && <span>Detected</span>}
              <When ms={t.at} />
              {sinceLabel(baselineAt, t.at) && <span className="va-step__since">{sinceLabel(baselineAt, t.at)}</span>}
            </span>
            <span className="va-step__who">
              <Avatar name={t.authorName ?? t.authorId} automation={t.source === 'AUTOMATION'} />
              <span className="va-truncate">{t.authorName ?? t.authorId ?? 'Unknown'}</span>
              {t.source === 'AUTOMATION' && <Badge tone="neutral">automation</Badge>}
              {t.source === 'APP' && <Badge tone="neutral">app</Badge>}
              {t.source === 'BASELINE' && <Badge tone="brand">restore</Badge>}
            </span>
            <span className="va-step__what"><StepChange step={t} richText={richText} /></span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepChange({ step, richText }: { step: Step; richText: boolean }) {
  if (step.detected) return <span className="va-muted">Seen changed by VAtlassian · not in Jira history</span>;
  if (richText) return <span className="va-muted">Edited</span>;
  const from = step.fromString ?? null;
  const to = step.toString ?? null;
  if (from == null && to == null) return <span className="va-muted">Changed</span>;
  return (
    <span className="va-step__values">
      <del className="va-del">{from == null || from === '' ? 'Empty' : from}</del>
      <IconArrowRight />
      <ins className="va-ins">{to == null || to === '' ? 'Empty' : to}</ins>
    </span>
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
