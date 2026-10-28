import { useEffect, useRef, useState } from 'react';
import { When } from '../ui/feedback';
import { Badge } from '../ui/primitives';
import { Avatar } from '../ui/brand';
import { formatTimestamp, plural, relativeTime, sinceLabel } from '../ui/format';
import { blocked, decide, reset, unavailable } from './fieldDecisions';
import type { Decisions, MixedFacts } from './fieldDecisions';
import type { ReactNode } from 'react';
import type { Attribution as Step, DiffField, DiffOp, DiffBlock, DiffCell, DiffItem, ReviewGroup } from './types';
const IconArrowRight = () => <span aria-hidden>→</span>;
const IconRemove = () => <span aria-hidden>−</span>;
const IconAdd = () => <span aria-hidden>+</span>;
const IconAttachment = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ verticalAlign: -1, marginRight: 4, display: 'inline-block' }}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

function renderFormattedText(text: string, field?: DiffField): ReactNode {
  if (!text) return text;
  const regex = /\[attachment(?::\s*([^\]]+)|\s+([0-9a-fA-F-]{36}|[0-9]+)|)\]/g;
  if (!regex.test(text)) return text;
  regex.lastIndex = 0;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    const resolvedName = match[1]?.trim();
    const id = match[2]?.trim();
    let name = resolvedName;
    if (!name && id) {
      name = field?.valueLabels?.[id] || (id.length === 36 ? 'Attached file' : `Attachment ${id}`);
    }
    name = name || 'Attachment';
    parts.push(
      <span key={match.index} className="va-pill va-pill--attachment" title={id || name}>
        <IconAttachment /> {name}
      </span>
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }
  return parts;
}

/**
 * The diff.
 *
 * A merge view. On the left, the work items this review covers: the parent,
 * the structure (work items added, removed or moved), then each drifted child.
 * On the right, every change on the one picked there, one field under another:
 * its name on top, the signed value on the left, the value now on the right.
 *
 * While deciding, a bar sits between the two values with an arrow at each
 * end, each pointing away from the value it keeps: → carries the signed value
 * across (reject), ← carries the new one across (approve). Hovering an arrow
 * lights the value that would win. Once chosen, the pair folds into one box
 * holding the final value, so a reviewer can walk the work items afterwards
 * and read exactly what the record will say.
 *
 * Nothing is rendered as an empty value that is really a missing one. A field
 * whose contents were never retained says so.
 */

/**
 * Deciding each change on its own. Present only in the review window, and only
 * once the authoritative evidence is on screen. `mixed` says whether the server
 * can take a field-by-field decision for this review at all; when it cannot, the
 * reviewer is told why and the whole-set actions are the way.
 */
export type DecisionMode = {
  state: Decisions;
  onChange: (next: Decisions) => void;
  mixed: MixedFacts;
  loading: boolean;
  error: string;
  /** A previous read is still on screen while its replacement loads. */
  held: boolean;
  /** This reviewer may decide at all. */
  eligible: boolean;
};

type Props = {
  fields: DiffField[];
  groups?: ReviewGroup[];
  mode?: 'drift' | 'versions';
  fromVersion?: number;
  toVersion?: number;
  incomplete?: boolean;
  focusDriftId?: string;
  /** A field picked elsewhere: its work item is opened and the field highlighted. */
  focusFieldId?: string;
  /** Bumped on every pick, so picking the same change twice still finds it. */
  focusKey?: number;
  /** When the baseline was signed: the origin every "+3 days" is measured from. */
  baselineAt?: number | null;
  /** The clock relative times are read against; tests pin it, callers omit it. */
  now?: number;
  decisions?: DecisionMode;
};

type Section = { key: string; issueKey: string | null; title: string; structure: boolean; version: number | null; fields: DiffField[] };

const SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR', 'COSMETIC'];
const severity = (field: DiffField) => {
  const rank = SEVERITY.indexOf(field.materiality ?? 'COSMETIC');
  return rank < 0 ? SEVERITY.length : rank;
};

const ArrowRight = () => <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M3 9h11M10 5l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const ArrowLeft = () => <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M15 9H4M8 5 4 9l4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export default function DiffView({ fields, groups, mode = 'drift', fromVersion, toVersion, incomplete = false, focusDriftId, focusFieldId, focusKey, baselineAt, now, decisions }: Props) {
  // A parent's review covers its children: one section per work item, each
  // child compared with its own latest baseline. The groups hold the same
  // fields as the flat list, so nothing is shown twice or left out.
  const grouped = Boolean(groups && groups.length > 0);
  const sections: Section[] = (grouped
    ? groups!.map(group => ({
      key: group.kind === 'STRUCTURE' ? 'structure' : `issue-${group.issueKey}`,
      issueKey: group.kind === 'STRUCTURE' ? null : group.issueKey ?? null,
      title: group.kind === 'STRUCTURE' ? 'Work items added, removed or moved' : group.summary ?? group.issueKey ?? 'Work item',
      structure: group.kind === 'STRUCTURE',
      version: group.kind === 'ISSUE' ? group.baselineVersion ?? null : null,
      fields: group.fields
    }))
    : [{ key: 'all', issueKey: null, title: 'Changes', structure: false, version: null, fields: fields ?? [] }])
    .filter(section => section.fields.length > 0);
  const ordered = sections.flatMap(section => section.fields);

  const [sectionKey, setSectionKey] = useState<string | null>(null);
  // The change a citation pointed at flashes once; picking a work item clears it.
  const [flashId, setFlashId] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const focused = ordered.find(f => (!!focusFieldId && f.fieldId === focusFieldId)
    || (!!focusDriftId && (f.driftIds ?? []).includes(focusDriftId)));
  useEffect(() => {
    if (!focused) return;
    const home = sections.find(section => section.fields.includes(focused));
    if (home) setSectionKey(home.key);
    setFlashId(focused.fieldId);
  }, [focused?.fieldId, focusKey]);
  useEffect(() => {
    if (!flashId) return;
    [...(mainRef.current?.querySelectorAll<HTMLElement>('[data-field-id]') ?? [])]
      .find(node => node.dataset.fieldId === flashId)?.scrollIntoView?.({ block: 'nearest' });
  }, [flashId, sectionKey, focusKey]);

  if (ordered.length === 0) {
    return <div className="va-muted">{mode === 'versions'
      ? incomplete ? 'No visible differences. This comparison is incomplete.' : 'These signed versions have the same tracked content.'
      : 'No fields have changed since this work item was approved.'}</div>;
  }

  const section = sections.find(s => s.key === sectionKey) ?? sections[0];
  const historical = mode === 'versions';
  const deciding = !historical && decisions && decisions.mixed?.eligible && decisions.eligible ? decisions : null;
  const left = historical ? `Version ${fromVersion}` : section.version != null ? `Signed · version ${section.version}` : 'Signed';
  const right = historical ? `Version ${toVersion}` : 'Now';
  // The most severe change first, inside each work item. Between two signed
  // versions, a field that only entered or left tracking is not a difference
  // in content: those are named in one line instead of drawn as empty pairs.
  const scoped = historical ? section.fields.filter(f => f.scopeChange === 'ADDED' || f.scopeChange === 'REMOVED') : [];
  const shown = section.fields.filter(f => !scoped.includes(f)).sort((a, b) => severity(a) - severity(b));
  const fieldLabel = (f: DiffField) => (grouped ? f.label ?? f.fieldName : f.fieldName);
  const added = scoped.filter(f => f.scopeChange === 'ADDED').map(fieldLabel);
  const removed = scoped.filter(f => f.scopeChange === 'REMOVED').map(fieldLabel);
  const setAll = (choice: 'APPROVE' | 'REJECT') => {
    if (!deciding) return;
    deciding.onChange(section.fields.reduce((state, field) => decide(state, field, choice), deciding.state));
  };

  return (
    <div className={sections.length > 1 ? 'va-merge va-merge--rail' : 'va-merge'}>
      {sections.length > 1 && (
        <nav className="va-merge__rail" aria-label="Work items in this review">
          {sections.map(s => {
            const total = s.fields.length;
            const done = deciding ? s.fields.filter(f => deciding.state[f.fieldId]).length : null;
            const finished = done != null && done === total;
            return (
              <button key={s.key} type="button" aria-current={s === section ? 'true' : undefined}
                className={`va-merge__item${s === section ? ' is-selected' : ''}${finished ? ' is-done' : ''}`}
                onClick={() => { setSectionKey(s.key); setFlashId(null); }}>
                {s.issueKey && <span className="va-merge__item-key">{s.issueKey}</span>}
                <span className="va-merge__item-title">{s.title}</span>
                <span className="va-merge__item-progress">
                  {done == null ? plural(total, 'change') : finished ? 'Decided' : `${done} of ${total} decided`}
                </span>
                {done != null && <span className="va-merge__bar" aria-hidden><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>}
              </button>
            );
          })}
        </nav>
      )}
      <div className="va-merge__main" ref={mainRef} role="region" aria-label={section.issueKey ? `${section.issueKey} · ${section.title}` : section.title}>
        <div className="va-merge__head">
          <h3 className="va-merge__title">{section.issueKey ? `${section.issueKey} · ${section.title}` : section.title}</h3>
          <span className="va-secondary">{plural(historical ? shown.length : section.fields.length, historical ? 'difference' : 'change')}</span>
          <span className="va-spacer" />
          {deciding && <>
            <button type="button" className="va-link-button" onClick={() => setAll('REJECT')}>Keep all signed</button>
            <button type="button" className="va-link-button" onClick={() => setAll('APPROVE')}>Take all new</button>
          </>}
        </div>
        {decisions && !historical && !deciding && decisions.eligible && <p className="va-merge__note" role="note">{unavailable(decisions.mixed?.reason)}</p>}
        {added.length > 0 && <p className="va-merge__note">Newly tracked in {right.toLowerCase()}: {added.join(', ')}</p>}
        {removed.length > 0 && <p className="va-merge__note">No longer tracked after {left.toLowerCase()}: {removed.join(', ')}</p>}
        {shown.length > 0 && <div className={deciding ? 'va-merge__cols va-merge__cols--deciding' : 'va-merge__cols'} aria-hidden>
          <span>{left}</span>{deciding && <span />}<span>{right}</span>
        </div>}
        {shown.map(field => (
          <MergeField key={`${field.issueKey ?? ''}:${field.fieldId}`} field={field}
            // Inside its work item's section a field is named plainly.
            name={grouped ? field.label ?? field.fieldName : field.fieldName}
            left={left} right={right} now={now} baselineAt={baselineAt} historical={historical}
            deciding={deciding} flash={flashId === field.fieldId} />
        ))}
      </div>
    </div>
  );
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

const MATERIALITY: Record<string, string> = { CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor', COSMETIC: 'Formatting only' };

/**
 * One field: its name on top, then the two values. Deciding, a bar between
 * them; decided, one box with the final value and Undo.
 */
function MergeField({ field, name, left, right, now, baselineAt, historical, deciding, flash }: {
  field: DiffField; name: string; left: string; right: string; now?: number; baselineAt?: number | null;
  historical: boolean; deciding: DecisionMode | null; flash: boolean;
}) {
  const [preview, setPreview] = useState<'keep' | 'take' | null>(null);
  const who = historical ? null : whoLine(field, now);
  const choice = deciding?.state[field.fieldId] ?? null;
  const why = deciding ? blocked(field) : null;
  const level = field.materiality ?? 'COSMETIC';
  const choose = (next: 'APPROVE' | 'REJECT') => { setPreview(null); deciding!.onChange(decide(deciding!.state, field, next)); };
  const hover = (side: 'keep' | 'take' | null) => ({
    onMouseEnter: () => setPreview(side), onMouseLeave: () => setPreview(null),
    onFocus: () => setPreview(side), onBlur: () => setPreview(null)
  });

  return (
    <article data-field-id={field.fieldId} id={`field-${field.fieldId}`} aria-label={name}
      className={`va-mfield${flash ? ' va-highlight' : ''}${choice ? ' is-decided' : ''}`}>
      <header className="va-mfield__head">
        <span className={`va-sev va-sev--${level}`} title={MATERIALITY[level] ?? level} aria-label={MATERIALITY[level] ?? level} />
        <h4 className="va-mfield__name">{name}</h4>
        {who && <span className="va-mfield__who" title={who.title}>{who.text}</span>}
      </header>
      {choice ? (
        <div className={`va-final va-final--${choice === 'APPROVE' ? 'took' : 'kept'}`}>
          <div className="va-final__value"><SideBody field={field} side={choice === 'APPROVE' ? 'after' : 'before'} /></div>
          <span className="va-final__tag">{choice === 'APPROVE' ? <><ArrowLeft />Took new</> : <><ArrowRight />Kept signed</>}</span>
          <button type="button" className="va-link-button" onClick={() => deciding!.onChange(reset(deciding!.state, field.fieldId))}>Undo</button>
        </div>
      ) : (
        <div className={`va-pair${deciding ? ' va-pair--deciding' : ''}${preview ? ` is-${preview}` : ''}`}>
          <section className="va-pair__side va-pair__side--old" aria-label={left}><SideBody field={field} side="before" /></section>
          {deciding && (
            <div className="va-switch" role="group" aria-label={`Decision for ${name}`}>
              <button type="button" className="va-switch__keep" disabled={Boolean(why)} {...hover('keep')}
                aria-label={`Keep the signed value of ${name}`} title={why ?? 'Keep the signed value (reject this change)'}
                onClick={() => choose('REJECT')}><ArrowRight /></button>
              <button type="button" className="va-switch__take" {...hover('take')}
                aria-label={`Take the new value of ${name}`} title="Take the new value (approve this change)"
                onClick={() => choose('APPROVE')}><ArrowLeft /></button>
            </div>
          )}
          <section className="va-pair__side va-pair__side--new" aria-label={right}><SideBody field={field} side="after" /></section>
        </div>
      )}
      {why && !choice && <p className="va-subtlest va-mfield__why">{why}</p>}
      {!historical && <History field={field} baselineAt={baselineAt} />}
    </article>
  );
}

/** Every edit since signing, folded away until asked for. */
function History({ field, baselineAt }: { field: DiffField; baselineAt?: number | null }) {
  const count = (field.attribution ?? []).length;
  return (
    <details className="va-mfield__history">
      <summary>{count ? `Edit history · ${count}` : 'Edit history'}</summary>
      <Attribution field={field} baselineAt={baselineAt} />
    </details>
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

type Side = 'before' | 'after';

function SideBody({ field, side }: { field: DiffField; side: Side }) {
  if (side === 'before' && field.retained === false) {
    return <p className="va-muted">Its approved value was not kept, so it cannot be shown or restored.</p>;
  }
  switch (field.kind) {
    case 'adf': return <SideBlocks blocks={field.blocks} side={side} field={field} />;
    case 'text': return <div className="va-side__text"><SideOps ops={field.ops} side={side} field={field} /></div>;
    case 'attachments': {
      // A file's facts are what an auditor compares: size, type, who uploaded it and its audit id.
      const files = (side === 'before' ? field.removed : field.added) ?? [];
      if (!files.length) return <span className="va-muted">{side === 'before' ? 'No file removed.' : 'No file added.'}</span>;
      return <div className="va-file-changes">{files.map((item, i) => <FileFacts key={i} item={item} side={side} />)}</div>;
    }
    case 'multi':
    case 'links': {
      // Only the items that differ are known; the others are the same on both sides.
      const items = (side === 'before' ? field.removed : field.added) ?? [];
      const shown = items.map((item, i) => (
        <span key={i} className={`va-pill ${side === 'before' ? 'va-pill-before' : 'va-pill-after'}`}>
          {side === 'before' ? <IconRemove /> : <IconAdd />} {field.kind === 'links' ? describeLink(item, field) : itemName(field, item)}
        </span>));
      return (
        <div className="va-pill-change">
          {shown.length ? shown : <span className="va-muted">{side === 'before' ? 'Nothing was removed.' : 'Nothing was added.'}</span>}
          <div className="va-subtlest" style={{ marginTop: 6 }}>Items that did not change are the same on both sides.</div>
        </div>
      );
    }
    default: {
      const shown = display(field, side === 'before' ? field.before : field.after);
      return (
        <div className="va-side__text">
          {shown.text}
          {shown.id && shown.id !== shown.text && <span className="va-chip__id" style={{ marginLeft: 6 }}>id {shown.id}</span>}
        </div>
      );
    }
  }
}

function FileFacts({ item, side }: { item: DiffItem; side: Side }) {
  const details = typeof item === 'string' ? null : item;
  const name = details?.filename || details?.id || (typeof item === 'string' ? item : 'Unnamed file');
  const size = typeof details?.size === 'number' ? (details.size < 1024 ? `${details.size} bytes` : `${Math.round(details.size / 1024)} KB`) : null;
  return (
    <div className={`va-file-change va-file-change--${side === 'before' ? 'removed' : 'added'}`}>
      <div className="va-file-change__title">{side === 'before' ? <del className="va-del">{name}</del> : <ins className="va-ins">{name}</ins>}</div>
      <div className="va-file-change__facts">
        {size && <span>{size}</span>}
        {details?.mimeType && <span>{details.mimeType}</span>}
        {details?.authorName && <span>Uploaded by {details.authorName}</span>}
        {details?.created && <span>{formatTimestamp(details.created) ?? details.created}</span>}
        {details?.id && <span>Audit ID {details.id}</span>}
      </div>
    </div>
  );
}

const itemName = (field: DiffField, item: DiffItem) => {
  if (typeof item === 'string') {
    const d = display(field, item);
    return d.text || item;
  }
  const id = item.id ? String(item.id) : '';
  const resolved = item.filename || (id && field.valueLabels?.[id]);
  return resolved || item.id || display(field, item).text;
};

/** One side of a word-level edit: what the other side added or removed is left out. */
function SideOps({ ops, side, field }: { ops?: DiffOp[]; side: Side; field?: DiffField }) {
  if (!ops || ops.length === 0) return <span className="va-muted">No visible change.</span>;
  const mine = side === 'before' ? 'delete' : 'insert';
  const theirs = side === 'before' ? 'insert' : 'delete';
  return (
    <span>
      {ops.filter(op => op.op !== theirs).map((op, i) => op.op === mine
        ? (side === 'before' ? <del key={i} className="va-del">{renderFormattedText(op.text, field)}</del> : <ins key={i} className="va-ins">{renderFormattedText(op.text, field)}</ins>)
        : <span key={i}>{renderFormattedText(op.text, field)}</span>)}
    </span>
  );
}

/** One side of a rich-text field, block by block, with untouched stretches collapsed and tables kept as tables. */
function SideBlocks({ blocks, side, field }: { blocks?: DiffBlock[]; side: Side; field?: DiffField }) {
  if (!blocks || blocks.length === 0) return <div className="va-muted">No visible change.</div>;
  const out: ReactNode[] = [];
  let equal = 0;
  const flush = (key: number) => { if (equal) { out.push(<Unchanged key={`eq-${key}`} count={equal} />); equal = 0; } };
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    // A table's rows travel together, so the rows of one table stay one grid.
    const tableId = tableIdOf(block);
    if (tableId != null) {
      const rows: DiffBlock[] = [];
      while (i < blocks.length && tableIdOf(blocks[i]) === tableId) rows.push(blocks[i++]);
      i -= 1;
      flush(i);
      out.push(<SideTable key={`t-${i}`} rows={rows} side={side} field={field} />);
      continue;
    }
    if (block.op === 'equal') { equal += 1; continue; }
    // The other side's addition or removal has no counterpart here.
    if ((side === 'before' && block.op === 'insert') || (side === 'after' && block.op === 'delete')) continue;
    flush(i);
    const own = side === 'before' ? block.before : block.after;
    const text = own?.text ?? '';
    const mine = (side === 'before' && block.op === 'delete') || (side === 'after' && block.op === 'insert');
    out.push(block.op === 'modified' && (block.ops ?? []).length
      ? <div key={i} className="va-block"><SideOps ops={block.ops} side={side} field={field} /></div>
      : mine
        ? <div key={i} className="va-block">{side === 'before' ? <del className="va-del">{renderFormattedText(text, field)}</del> : <ins className="va-ins">{renderFormattedText(text, field)}</ins>}</div>
        : <div key={i} className="va-block">{block.op === 'move' && <span className="va-subtlest">moved · </span>}{renderFormattedText(text, field)}</div>);
  }
  flush(blocks.length);
  return <div className="va-side__text">{out}</div>;
}

/** The table a row belongs to, or null when this block is not a table row. */
function tableIdOf(block?: DiffBlock): string | null {
  const side = block?.after ?? block?.before;
  if (!side || side.type !== 'tableRow') return null;
  return side.tableId ?? 'table';
}

/**
 * One side of a table. A row the other side added or removed is left out; an
 * edited row shows, in the cell that changed, only this side's words.
 */
function SideTable({ rows, side, field }: { rows: DiffBlock[]; side: Side; field?: DiffField }) {
  const own = rows.filter(row => !(side === 'before' && row.op === 'insert') && !(side === 'after' && row.op === 'delete'));
  const changed = rows.filter(row => row.op !== 'equal');
  const every = (op: string) => changed.length > 0 && changed.every(row => row.op === op);
  if (own.length === 0) return <div className="va-block va-subtlest">{side === 'before' ? 'Table not present' : 'Table removed'}</div>;
  return (
    <div className="va-block va-block-table">
      {(every('insert') || every('delete')) && <div className="va-subtlest va-table-caption">{every('insert') ? 'Table added' : 'Table removed'}</div>}
      <table className="va-diff-table">
        <tbody>
          {own.map((row, r) => {
            const op = row.op === 'markOnly' || row.op === 'move' ? 'equal' : row.op === 'structure' ? 'modified' : row.op;
            const sideCells = (side === 'before' ? row.before : row.after)?.cells ?? [];
            const cells: DiffCell[] = row.cells ?? sideCells.map(c => ({ op, before: c.text ?? '', after: c.text ?? '', header: c.header, ops: [] }));
            return (
              <tr key={r} className={`va-diff-table__row va-diff-table__row--${op}`}>
                {cells.filter(cell => !(side === 'before' && cell.op === 'insert' && op === 'modified') && !(side === 'after' && cell.op === 'delete' && op === 'modified'))
                  .map((cell, c) => {
                    const Cell = cell.header ? 'th' : 'td';
                    const text = (side === 'before' ? cell.before : cell.after) ?? '';
                    return (
                      <Cell key={c} className={`va-diff-table__cell va-diff-table__cell--${cell.op}`}>
                        {cell.op === 'modified' && (cell.ops ?? []).length
                          ? <SideOps ops={cell.ops} side={side} field={field} />
                          : op === 'insert' && side === 'after' ? <ins className="va-ins">{renderFormattedText(text, field)}</ins>
                            : op === 'delete' && side === 'before' ? <del className="va-del">{renderFormattedText(text, field)}</del>
                              : renderFormattedText(text, field)}
                      </Cell>
                    );
                  })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Unchanged({ count }: {count:number}) {
  return <div className="va-block va-block-equal va-subtlest">{count} unchanged {count === 1 ? 'paragraph' : 'paragraphs'}</div>;
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
