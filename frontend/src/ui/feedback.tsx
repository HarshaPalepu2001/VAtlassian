import type { ReactNode } from 'react';
import { useId } from 'react';
import { Badge } from './primitives';
import { formatTimestamp } from './format';
import { assuranceLabel } from '../lib/assurance';
export function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) { return <div role={danger ? 'alert' : 'status'} className={`va-banner va-banner-${danger ? 'danger' : 'info'}`}>{children}</div>; }
export function AssuranceChip({ level }: { level?: string | null }) { return <Badge tone={level === 'ESIGNATURE' ? 'brand' : 'neutral'}>{assuranceLabel(level)}</Badge>; }
export function MaterialityBadge({ level }: { level?: string }) { return <Badge tone={level === 'CRITICAL' ? 'danger' : level === 'MAJOR' ? 'warning' : 'neutral'}>{level ?? 'Unclassified'}</Badge>; }
export function When({ ms }: { ms?: number | string | null }) { return <time>{formatTimestamp(ms == null ? null : Number(ms)) ?? 'Time not recorded'}</time>; }
export function Collapsible({open,onToggle,header,children}: {open:boolean;onToggle:()=>void;header:ReactNode;children:ReactNode}) {
 const id=useId(); return <section className="va-card"><button type="button" className="va-collapse" aria-expanded={open} aria-controls={id} onClick={onToggle}>{header}<span aria-hidden>{open?'−':'+'}</span></button>{open&&<div id={id}>{children}</div>}</section>;
}
