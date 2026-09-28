import { useState } from 'react';
import type { DiffField, ReportGroup, ReviewReport, ReportMeta, ScopeImpact as ScopeImpactData } from './types';
import { Badge } from '../ui/primitives';
import { Avatar, Icon } from '../ui/brand';

/**
 * The AI summary, written for the person reading it.
 *
 * THE CITATION CHIPS ARE THE POINT. Every claim the model makes carries the
 * drift ids it was based on, validated server-side against the evidence
 * actually sent — anything fabricated is stripped before it reaches here. Each
 * chip names the field it came from and jumps to the exact change, so a
 * reviewer goes from "the estimate more than doubled after approval" to the
 * precise edit in one click.
 *
 * PERSONAL, NOT CHATTY. The page opens with who the reader is to this work
 * item — whether they signed the baseline, whether the decision is theirs —
 * because that is what changes how they should read it. The side column is
 * computed from the recorded changes, not written by the model, so the facts a
 * reviewer leans on most are the ones that cannot be hallucinated.
 */

const VERDICT = {
  no_material_change: { tone: 'success', label: 'Nothing material changed' },
  review_recommended: { tone: 'info', label: 'Worth a look' },
  material_change: { tone: 'warning', label: 'Material change' },
  scope_change: { tone: 'danger', label: 'Scope changed after approval' }
} as const;

export type Viewer = {
  name?: string | null;
  /** The viewer signed the baseline these changes are measured against. */
  signedIt?: boolean;
  /** The role that decides this drift, and whether the viewer holds it. */
  decides?: boolean;
  role?: string | null;
  version?: number | null;
};

type Props = {
  report?: ReviewReport | null;
  meta?: ReportMeta;
  fields?: DiffField[];
  viewer?: Viewer;
  onCite?: (id: string) => void;
  onGenerate?: () => void;
  busy?: boolean;
  fallback?: string;
};

const DETAIL_KEY = 'va.ai.detail';
function readDetail(): 'brief' | 'full' {
  try { return window.localStorage.getItem(DETAIL_KEY) === 'brief' ? 'brief' : 'full'; } catch { return 'full'; }
}

export default function ReportView({ report, meta, fields = [], viewer, onCite, onGenerate, busy = false, fallback }: Props) {
  const [detail, setDetail] = useState<'brief' | 'full'>(readDetail);
  const choose = (next: 'brief' | 'full') => {
    setDetail(next);
    try { window.localStorage.setItem(DETAIL_KEY, next); } catch { /* a preference, never required */ }
  };

  if (!report) {
    return (
      <div className="va-ai-empty">
        <Icon name="sparkle" size={28} />
        <h3 className="va-ai-empty__title">{viewer?.name ? `${firstName(viewer.name)}, get these changes explained` : 'Get these changes explained'}</h3>
        <p className="va-secondary">{fallback ?? 'A short summary of what changed since approval, why it may matter, and what to ask before you decide. Every point links to the change it is based on.'}</p>
        {onGenerate && <button type="button" className="va-btn va-btn--discovery" disabled={busy} onClick={onGenerate}>{busy ? 'Preparing summary…' : 'Summarise with AI'}</button>}
      </div>
    );
  }

  const verdict = VERDICT[report.verdictHint as keyof typeof VERDICT] ?? VERDICT.review_recommended;
  const citeLabel = labelsFor(fields);

  return (
    <div className="va-ai">
      <div className="va-ai__main">
        {viewer?.name && (
          <div className="va-ai__for">
            <Avatar name={viewer.name} />
            <strong>For {viewer.name}</strong>
            <span className="va-secondary">{relation(viewer)}</span>
          </div>
        )}
        <h3 className="va-ai__headline">{report.headline}</h3>
        {detail === 'full' && report.narrative && <p className="va-ai__narrative">{report.narrative}</p>}

        <div className="va-ai__controls" role="group" aria-label="Summary detail">
          <span className="va-subtlest">Detail</span>
          <span className="va-segmented">
            <button type="button" aria-pressed={detail === 'brief'} onClick={() => choose('brief')}>Brief</button>
            <button type="button" aria-pressed={detail === 'full'} onClick={() => choose('full')}>Full</button>
          </span>
        </div>

        <div className={`va-ai__verdict va-ai__verdict--${verdict.tone}`}>
          <Icon name={verdict.tone === 'success' ? 'check' : verdict.tone === 'info' ? 'info' : 'warning'} />
          <strong>{verdict.label}</strong>
        </div>

        <ol className="va-ai__findings">
          {(report.changeGroups ?? []).map((group, i) => (
            <Finding key={i} index={i + 1} group={group} detail={detail} onCite={onCite} citeLabel={citeLabel} />
          ))}
        </ol>

        {(report.questionsForReviewer ?? []).length > 0 && (
          <section className="va-ai__questions">
            <h4 className="va-h3">Before you decide</h4>
            <ul>
              {(report.questionsForReviewer ?? []).map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </section>
        )}
      </div>

      <aside className="va-ai__side" aria-label="At a glance">
        <ScopeImpact impact={report.scopeImpact} />
        <People fields={fields} viewer={viewer} />
        <Provenance meta={meta} groundingIssues={report.groundingIssues} onGenerate={onGenerate} busy={busy} />
      </aside>
    </div>
  );
}

function firstName(name: string) { return name.trim().split(/\s+/)[0]; }

/** "you signed v3 · you decide as QA Lead" — who the reader is to this work item. */
function relation(viewer: Viewer): string {
  const parts: string[] = [];
  if (viewer.signedIt) parts.push(viewer.version != null ? `you signed version ${viewer.version}` : 'you signed this baseline');
  if (viewer.decides) parts.push(viewer.role ? `you decide as ${viewer.role}` : 'the decision is yours');
  else if (viewer.role) parts.push(`${viewer.role} decides`);
  return parts.length ? `· ${parts.join(' · ')}` : '';
}

/** drift id → the field it belongs to, so a chip can say "Story points" not "evidence 1". */
function labelsFor(fields: DiffField[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of fields) for (const id of f.driftIds ?? []) map.set(id, [f.issueKey, f.label ?? f.fieldName].filter(Boolean).join(' · '));
  return map;
}

function Finding({ index, group, detail, onCite, citeLabel }: { index: number; group: ReportGroup; detail: 'brief' | 'full'; onCite?: (id: string) => void; citeLabel: Map<string, string> }) {
  return (
    <li className={group.ungrounded ? 'va-finding va-finding--ungrounded' : 'va-finding'}>
      <span className="va-finding__index">{index}</span>
      <div className="va-finding__body">
        <div className="va-finding__head">
          <strong>{group.title}</strong>
          {group.risk === 'high' && <Badge tone="danger">high risk</Badge>}
          {group.risk === 'medium' && <Badge tone="warning">medium risk</Badge>}
          <span className="va-grow" />
          {group.whoAndWhen && <span className="va-subtlest">{group.whoAndWhen}</span>}
        </div>
        <div>{group.whatChanged}</div>
        {detail === 'full' && group.whyItMatters && <div className="va-secondary">{group.whyItMatters}</div>}
        <div className="va-row">
          {/* One chip per change: a field edited twice is still one place to look. */}
          {[...new Map((group.driftIds ?? []).map((id, i) => [citeLabel.get(id) ?? `evidence ${i + 1}`, id])).entries()].map(([label, id]) => (
            <button key={id} type="button" className="va-cite" onClick={() => onCite?.(id)} title="Jump to the exact change this is based on">
              {label} ↗
            </button>
          ))}
          {group.ungrounded && (
            // NEVER HIDDEN. A point the model could not ground is shown, greyed,
            // with a warning — concealing it would hide the fact that the tool
            // produced an unsupported claim, which is precisely what a reviewer
            // needs to know about the tool they are trusting.
            <span className="va-subtlest va-row">
              <Icon name="warning" size={14} /> this point could not be tied to a recorded change — treat it with caution
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function ScopeImpact({ impact }: { impact?: ScopeImpactData }) {
  if (!impact) return null;
  const rows = [
    impact.estimateChanged && 'Estimate',
    impact.acceptanceCriteriaChanged && 'Acceptance criteria',
    impact.dueDateChanged && 'Due date'
  ].filter((value): value is string => typeof value === 'string');
  if (rows.length === 0 && !impact.note) return null;
  return (
    <section className="va-side-block">
      <h4 className="va-side-block__title">Scope impact</h4>
      {rows.map(r => <div key={r} className="va-spread"><span className="va-secondary">{r}</span><strong>Changed</strong></div>)}
      {impact.note && <p className="va-secondary">{impact.note}</p>}
    </section>
  );
}

/** Who made the edits — counted from the recorded trail, not from the model. */
function People({ fields, viewer }: { fields: DiffField[]; viewer?: Viewer }) {
  const counts = new Map<string, { edits: number; automation: boolean }>();
  for (const field of fields) for (const step of field.attribution ?? []) {
    const name = step.authorName ?? 'Unknown';
    const prior = counts.get(name) ?? { edits: 0, automation: false };
    counts.set(name, { edits: prior.edits + 1, automation: prior.automation || step.source === 'AUTOMATION' });
  }
  if (counts.size === 0) return null;
  const viewerEdited = viewer?.name ? counts.has(viewer.name) : null;
  return (
    <section className="va-side-block">
      <h4 className="va-side-block__title">Who changed things</h4>
      {[...counts.entries()].sort((a, b) => b[1].edits - a[1].edits).map(([name, c]) => (
        <div key={name} className="va-row">
          <Avatar name={name} size={22} automation={c.automation} />
          <span className="va-grow">{name}</span>
          <span className="va-subtlest">{c.edits === 1 ? '1 edit' : `${c.edits} edits`}</span>
        </div>
      ))}
      {viewerEdited === false && <span className="va-success-text va-row"><Icon name="check" size={14} /> You made none of these edits</span>}
      {viewerEdited === true && <span className="va-warning-text va-row"><Icon name="warning" size={14} /> Some of these edits are yours</span>}
    </section>
  );
}

/**
 * How this summary was produced.
 *
 * Always shown. A reviewer must never be unable to tell a model's analysis
 * from a template's, and one that had citations stripped deserves to be
 * labelled as such — a report that needed correcting is a report to read more
 * carefully.
 */
function Provenance({ meta, groundingIssues = 0, onGenerate, busy }: { meta?: ReportMeta; groundingIssues?: number; onGenerate?: () => void; busy?: boolean }) {
  return (
    <section className="va-side-block va-side-block--boxed">
      <h4 className="va-side-block__title">How this was written</h4>
      {meta?.degraded
        ? <p className="va-secondary" title={meta.degradedReason ?? ''}>Written without AI — the comparison in Changes is exact.</p>
        : <p className="va-secondary" title={meta?.model}>{meta?.cached ? 'AI summary, from cache.' : 'AI summary.'} Written from the recorded changes only; every point links to the change it came from.</p>}
      {groundingIssues > 0 && (
        <p className="va-warning-text">{groundingIssues} unsupported point{groundingIssues === 1 ? ' was' : 's were'} removed.</p>
      )}
      <p className="va-secondary">This summary is advice. Your signature covers the recorded changes, not this text.</p>
      {onGenerate && <button type="button" className="va-link-button" disabled={busy} onClick={onGenerate}>{busy ? 'Preparing summary…' : 'Regenerate'}</button>}
    </section>
  );
}
