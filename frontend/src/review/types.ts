export type DiffOp = { op: string; text: string };
export type MarkChange = { from?: string[]; to?: string[] };
/** One cell of a table row, paired with the cell in the same position on the
 *  other side. `before`/`after` are the cell's plain text. */
export type DiffCell = { op: string; before?: string | null; after?: string | null; header?: boolean; ops?: DiffOp[] };
export type DiffBlockSide = { text?: string; type?: string; tableId?: string; cells?: { text?: string; header?: boolean }[] };
export type DiffBlock = { op: string; before?: DiffBlockSide; after?: DiffBlockSide; ops?: DiffOp[]; cells?: DiffCell[]; markChange?: MarkChange };
export type DiffItem = string | { id?: string; filename?: string; type?: string; inward?: string; outward?: string };
export type DiffField = {
 fieldId: string; fieldName: string; summary?: string; driftIds?: string[]; semanticChange?: boolean; materiality?: string;
 attributionStatus?: 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_COLLECTED';
 retained?: boolean; restorable?: string; kind: string; blocks?: DiffBlock[]; ops?: DiffOp[]; added?: DiffItem[]; removed?: DiffItem[]; replaced?: DiffItem[];
 before?: unknown; after?: unknown; churned?: boolean; attribution?: {at: number; authorName?: string; authorId?: string; source?: string; detected?:boolean; fromString?:string|null; toString?:string|null}[];
 /** { storedIdentifier: displayName } for values the comparison reduced to ids. */
 valueLabels?: Record<string, string>;
 /** The field's own name, for a view already headed by its work item (a tree review). */
 label?: string;
 /** The work item this change belongs to, in a tree review. */
 issueKey?: string;
};
/** One section of a parent's review: the parent, the structure, or one drifted child
 *  (compared with that child's own latest baseline, `baselineVersion`). */
export type ReviewGroup = {
 kind: 'ISSUE' | 'STRUCTURE'; issueKey?: string | null; summary?: string | null; isRoot?: boolean;
 baselineVersion?: number | null; fields: DiffField[];
};
export type ReportGroup = {title:string; risk?:string; whoAndWhen?:string;whatChanged:string;whyItMatters?:string;driftIds?:string[];ungrounded?:boolean};
export type ScopeImpact = { estimateChanged?:boolean;acceptanceCriteriaChanged?:boolean;dueDateChanged?:boolean;note?:string };
export type ReviewReport = {verdictHint:string;headline:string;narrative:string;changeGroups?:ReportGroup[];questionsForReviewer?:string[];scopeImpact?:ScopeImpact;groundingIssues?:number};
export type ReportMeta = {degraded?:boolean;degradedReason?:string;model?:string;cached?:boolean};
