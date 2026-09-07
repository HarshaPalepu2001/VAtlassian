export type DiffOp = { op: string; text: string };
export type MarkChange = { from?: string[]; to?: string[] };
export type DiffBlock = { op: string; before?: { text?: string }; after?: { text?: string }; ops?: DiffOp[]; markChange?: MarkChange };
export type DiffItem = string | { id?: string; filename?: string; type?: string; inward?: string; outward?: string };
export type DiffField = {
 fieldId: string; fieldName: string; summary?: string; driftIds?: string[]; semanticChange?: boolean; materiality?: string;
 retained?: boolean; restorable?: string; kind: string; blocks?: DiffBlock[]; ops?: DiffOp[]; added?: DiffItem[]; removed?: DiffItem[]; replaced?: DiffItem[];
 before?: unknown; after?: unknown; churned?: boolean; attribution?: {at: number; authorName?: string; source?: string}[];
};
export type ReportGroup = {title:string; risk?:string; whoAndWhen?:string;whatChanged:string;whyItMatters?:string;driftIds?:string[];ungrounded?:boolean};
export type ScopeImpact = { estimateChanged?:boolean;acceptanceCriteriaChanged?:boolean;dueDateChanged?:boolean;note?:string };
export type ReviewReport = {verdictHint:string;headline:string;narrative:string;changeGroups?:ReportGroup[];questionsForReviewer?:string[];scopeImpact?:ScopeImpact;groundingIssues?:number};
export type ReportMeta = {degraded?:boolean;degradedReason?:string;model?:string;cached?:boolean};
