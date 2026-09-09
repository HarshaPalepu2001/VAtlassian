import type { ReactNode } from 'react';
import { useId } from 'react';
import { Badge } from './primitives';
import { formatTimestamp } from './format';
import { assuranceLabel } from '../lib/assurance';
export function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) { return <div role={danger ? 'alert' : 'status'} className={`va-banner va-banner-${danger ? 'danger' : 'info'}`}>{children}</div>; }
export function AssuranceChip({ level }: { level?: string | null }) { return <Badge tone={level === 'ESIGNATURE' ? 'brand' : 'neutral'}>{assuranceLabel(level)}</Badge>; }
/**
 * How much attention a change is owed.
 *
 * Sentence case, and "Formatting" rather than "COSMETIC" — the enum is how the
 * backend classifies a change, not how a reviewer would say it out loud. A row
 * of shouted enum names reads as a database dump.
 */
const MATERIALITY: Record<string, { tone: 'danger'|'warning'|'brand'|'neutral'; label: string }> = {
  CRITICAL: { tone: 'danger', label: 'Critical' },
  MAJOR: { tone: 'warning', label: 'Major' },
  MINOR: { tone: 'brand', label: 'Minor' },
  COSMETIC: { tone: 'neutral', label: 'Formatting' }
};

export function MaterialityBadge({ level }: { level?: string }) {
  const m = MATERIALITY[level ?? ''] ?? { tone: 'neutral' as const, label: 'Unclassified' };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
export function When({ ms }: { ms?: number | string | null }) { return <time>{formatTimestamp(ms == null ? null : Number(ms)) ?? 'Time not recorded'}</time>; }
/**
 * A disclosure.
 *
 * Deliberately NOT a card. It used to wrap itself in `.va-card`, so every use
 * inside a card produced a border inside a border — the nested-panel look that
 * makes an interface feel assembled rather than designed. It is a rule and a
 * control; the surface it sits on is the caller's business.
 */
export function Collapsible({open,onToggle,header,children}: {open:boolean;onToggle:()=>void;header:ReactNode;children:ReactNode}) {
 const id=useId();
 return <section className="va-disclosure">
  <button type="button" className="va-collapse" aria-expanded={open} aria-controls={id} onClick={onToggle}>
   {header}
   <span className={open?'va-ledger__toggle va-ledger__toggle--open':'va-ledger__toggle'} aria-hidden/>
  </button>
  {open&&<div id={id}>{children}</div>}
 </section>;
}
