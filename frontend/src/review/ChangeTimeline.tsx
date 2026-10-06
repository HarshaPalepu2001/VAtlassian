import { formatDate, formatTimestamp } from '../ui/format';
import type { DiffField } from './types';

type Mark = { at: number; fieldId: string; fieldName: string; author: string; materiality: string; detected: boolean };

/**
 * WHEN, AT A GLANCE.
 *
 * One line from the moment the baseline was signed to now, with a dot for
 * every recorded edit. It answers the question a list of rows cannot: did
 * this drift happen the morning after approval, or in a rush yesterday? Dots
 * are coloured by materiality, like the rows, and each one is a button that
 * takes the reviewer to the change it stands for.
 *
 * Edits at the same instant (one Jira save touching several fields) share a
 * dot, because they were one action.
 */
export default function ChangeTimeline({ fields, baselineAt, now = Date.now(), onPick }: { fields: DiffField[]; baselineAt?: number | null; now?: number; onPick?: (fieldId: string) => void }) {
  const marks: Mark[] = fields.flatMap(field => (field.attribution ?? [])
    .filter(step => Number.isFinite(Number(step.at)) && Number(step.at) > 0)
    .map(step => ({ at: Number(step.at), fieldId: field.fieldId, fieldName: field.label ?? field.fieldName,
      author: step.authorName ?? 'Unknown', materiality: field.materiality ?? 'COSMETIC', detected: step.detected === true })));
  if (marks.length === 0) return null;

  const start = baselineAt && Number(baselineAt) > 0 ? Number(baselineAt) : Math.min(...marks.map(m => m.at));
  const end = Math.max(now, ...marks.map(m => m.at));
  const span = Math.max(1, end - start);
  const position = (at: number) => `${(((at - start) / span) * 100).toFixed(2)}%`;

  const moments = new Map<number, Mark[]>();
  for (const mark of marks) moments.set(mark.at, [...(moments.get(mark.at) ?? []), mark]);
  const rank = (m: string) => ['CRITICAL', 'MAJOR', 'MINOR', 'COSMETIC'].indexOf(m);

  return (
    <div className="va-timeline" role="group" aria-label="When each change happened">
      <div className="va-timeline__track">
        <span className="va-timeline__rail" />
        <span className="va-timeline__signed" style={{ left: '0%' }} title={formatTimestamp(start) ?? undefined} />
        {[...moments.entries()].map(([at, group]) => {
          const worst = group.map(m => m.materiality).sort((a, b) => rank(a) - rank(b))[0];
          const label = `${formatTimestamp(at)} · ${group.every(m => m.detected) ? 'Detected by VAtlassian' : [...new Set(group.filter(m => !m.detected).map(m => m.author))].join(', ')} · ${group.map(m => m.fieldName).join(', ')}`;
          return (
            <button key={at} type="button" className={`va-timeline__dot va-timeline__dot--${worst}`} style={{ left: position(at) }}
              title={label} aria-label={label} onClick={() => onPick?.(group[0].fieldId)}>
              {group.length > 1 && <span className="va-timeline__count">{group.length}</span>}
            </button>
          );
        })}
        <span className="va-timeline__now" style={{ left: '100%' }} />
      </div>
      <div className="va-timeline__labels">
        <span>{formatDate(start)} · signed</span>
        <span>Now</span>
      </div>
    </div>
  );
}
