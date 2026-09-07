import type { ReportGroup, ReviewReport, ReportMeta, ScopeImpact as ScopeImpactData } from './types';
import { Badge } from '../ui/primitives';
const IconWarning = () => <span aria-hidden>⚠</span>;

/**
 * The AI report.
 *
 * THE CITATION CHIPS ARE THE POINT. Every claim the model makes carries the
 * drift ids it was based on, validated server-side against the evidence
 * actually sent — anything fabricated is stripped before it reaches here. Each
 * chip scrolls to and flashes the exact field it came from, so a reviewer goes
 * from "the estimate more than doubled after approval" to the precise change in
 * one click.
 *
 * That is the difference between a summary you skim and evidence you can act
 * on, and it is why this component is mostly wiring rather than prose.
 */

const VERDICT = {
  no_material_change: { tone: 'success', label: 'Nothing material changed' },
  review_recommended: { tone: 'info', label: 'Worth a look' },
  material_change: { tone: 'warn', label: 'Material change' },
  scope_change: { tone: 'danger', label: 'Scope changed after approval' }
};

export default function ReportView({ report, meta, fallback, onCite }: {report?:ReviewReport|null;meta?:ReportMeta;fallback?:string;onCite?:(id:string)=>void}) {
  if (!report) {
    return (
      <div className="va-card">
        <div className="va-muted">{fallback}</div>
      </div>
    );
  }

  const verdict = VERDICT[report.verdictHint as keyof typeof VERDICT] ?? VERDICT.review_recommended;

  return (
    <div className={`va-banner va-banner-${verdict.tone}`}>
      <div className="va-spread" style={{ marginBottom: 6 }}>
        <strong>{verdict.label}</strong>
        <ProvenanceNote meta={meta} groundingIssues={report.groundingIssues} />
      </div>

      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>{report.headline}</div>
      <div style={{ marginBottom: 10 }}>{report.narrative}</div>

      {(report.changeGroups ?? []).map((group, i) => (
        <Group key={i} group={group} onCite={onCite} />
      ))}

      {(report.questionsForReviewer ?? []).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="va-h3" style={{ marginBottom: 4 }}>Before you decide</div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {(report.questionsForReviewer ?? []).map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      )}

      <ScopeImpact impact={report.scopeImpact} />
    </div>
  );
}

function Group({ group, onCite }: {group:ReportGroup;onCite?:(id:string)=>void}) {
  return (
    <div
      style={{
        marginTop: 10,
        paddingLeft: 10,
        borderLeft: '2px solid var(--va-border)',
        opacity: group.ungrounded ? 0.65 : 1
      }}
    >
      <div className="va-row">
        <strong style={{ fontSize: 13 }}>{group.title}</strong>
        {group.risk === 'high' && <Badge tone="danger">high risk</Badge>}
        {group.risk === 'medium' && <Badge tone="warning">medium risk</Badge>}
      </div>

      <div className="va-subtlest">{group.whoAndWhen}</div>
      <div style={{ marginTop: 4 }}>{group.whatChanged}</div>
      <div className="va-muted" style={{ marginTop: 2 }}>{group.whyItMatters}</div>

      <div className="va-row" style={{ marginTop: 6 }}>
        {(group.driftIds ?? []).map((id, i) => (
          <button
            key={id}
            type="button"
            className="va-cite"
            onClick={() => onCite?.(id)}
            title="Jump to the exact change this is based on"
          >
            evidence {i + 1}
          </button>
        ))}
        {group.ungrounded && (
          // NEVER HIDDEN. A group the model could not ground is shown, greyed,
          // with a warning — concealing it would hide the fact that the tool
          // produced an unsupported claim, which is precisely what a reviewer
          // needs to know about the tool they are trusting.
          <span className="va-subtlest" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <IconWarning /> this point could not be tied to a recorded change — treat it with caution
          </span>
        )}
      </div>
    </div>
  );
}

function ScopeImpact({ impact }: {impact?:ScopeImpactData}) {
  if (!impact) return null;
  const flags = [
    impact.estimateChanged && 'estimate',
    impact.acceptanceCriteriaChanged && 'acceptance criteria',
    impact.dueDateChanged && 'due date'
  ].filter((value): value is string => typeof value === 'string');

  if (flags.length === 0 && !impact.note) return null;

  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--va-border)' }}>
      {flags.length > 0 && (
        <div className="va-row">
          <span className="va-h3">Scope</span>
          {flags.map((f) => <Badge key={f} tone="warning">{f} changed</Badge>)}
        </div>
      )}
      {impact.note && <div className="va-muted" style={{ marginTop: 4 }}>{impact.note}</div>}
    </div>
  );
}

/**
 * How this summary was produced.
 *
 * Always shown, quietly. A reviewer must never be unable to tell a model's
 * analysis from a template's, and one that had citations stripped deserves to
 * be labelled as such — a report that needed correcting is a report to read
 * more carefully.
 */
function ProvenanceNote({ meta, groundingIssues = 0 }: {meta?:ReportMeta;groundingIssues?:number}) {
  if (!meta) return null;

  if (meta.degraded) {
    return (
      <span className="va-subtlest" title={meta.degradedReason ?? ''}>
        written without AI — the comparison below is exact
      </span>
    );
  }

  return (
    <span className="va-row">
      {groundingIssues > 0 && (
        <span className="va-subtlest" style={{ color: 'var(--va-warning)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconWarning /> {groundingIssues} unsupported point{groundingIssues === 1 ? '' : 's'} removed
        </span>
      )}
      <span className="va-subtlest" title={meta.model}>
        AI summary{meta.cached ? ' · cached' : ''}
      </span>
    </span>
  );
}
