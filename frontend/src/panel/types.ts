import type { AssuranceLevel } from '../lib/assurance';
import type { DiffField } from '../review/types';

/** One controlled, gated transition described the same way for every viewer —
 *  eligible or not. `canApprove` is the only field that varies by viewer;
 *  everything else describes the rule itself. See panelSummary.js. */
export type PanelTransition = {
  transitionId: string;
  toStatusId: string;
  toStatusName?: string | null;
  name?: string | null;
  meaning?: string | null;
  requiredRole?: string | null;
  requiredAssurance: AssuranceLevel;
  capturesBaseline?: boolean;
  blocksOnDrift?: boolean;
  anyStatus?: boolean;
  label?: string;
  canApprove: boolean;
};

export type PendingApproval = { approvalId: string; transitionId?: string; state: string; expiresAt?: number };

export type PanelBaseline = {
  baselineId: string;
  version: number;
  approvedName?: string | null;
  transitionAt?: number | null;
  capturedAt?: number | null;
  assuranceLevel?: AssuranceLevel | null;
  fidelity?: string | null;
  nodeCount: number;
  edgeCount: number;
  totalFieldCount: number;
  treeHash: string | null;
  policyIncomplete?: boolean;
};

export type PanelLatestApproval = {
  decision: string;
  state: string;
  actorName?: string | null;
  decidedAt?: number | null;
  transitionId?: string | null;
};

export type PanelRestore = {
  restoreId: string;
  state: string;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

/** The compact read from `panel:getSummary` — everything the panel needs to
 *  paint immediately. Never carries recursive tree detail, retained values,
 *  changelog attribution, or full field-level diffs; those load lazily
 *  through `panel:getEvidence` (see usePanelEvidence.ts). */
export type PanelSummary = {
  issue: { id?: string; key?: string; summary?: string; status?: { id?: string; name?: string; statusCategory?: { key?: string } } };
  controlled?: boolean;
  tier: 'actor' | 'observer';
  state: string;
  actorName?: string | null;
  eligibility: { eligible: boolean; reason?: string | null };
  credentialEnrolled?: boolean;
  transitions: PanelTransition[];
  baseline: PanelBaseline | null;
  latestApproval: PanelLatestApproval | null;
  drift: { count: number; materialCount: number; decidesDrift: boolean; policyIncomplete: boolean; canApprove: boolean; canReject: boolean };
  restore: PanelRestore | null;
  approval: { requiredRole?: string | null; requiredAssurance?: AssuranceLevel | null; meaning?: string | null; pending: PendingApproval | null };
  adminIncidentCount?: number;
  error?: string;
};

export type BaselineField = { fieldId: string; fieldName: string; materiality?: string; retained: boolean; digest?: string; preview?: { text?: string; empty?: boolean; truncated?: boolean; more?: number } | null };
export type BaselineRecordData = { version: number; approvedName?: string; approvedAt?: number; capturedAt?: number; assuranceLevel?: AssuranceLevel; fidelity?: string; contentHash?: string; fieldCount: number; retainedCount: number; fields: BaselineField[]; history?: { version: number; approvedName?: string; approvedAt?: number; assuranceLevel?: AssuranceLevel }[] };

/** The heavy, lazily-loaded read from `panel:getEvidence`. Rejected server-side
 *  as STALE_EVIDENCE when the caller's expected baseline id/version no longer
 *  matches the latest active baseline — see usePanelEvidence.ts. */
export type PanelEvidence = {
  baselineId: string | null;
  baselineVersion: number;
  evidenceHash?: string | null;
  description?: string;
  descriptionEmpty?: boolean;
  descriptionTruncated?: boolean;
  assignee?: unknown;
  reporter?: unknown;
  record: BaselineRecordData | null;
  drift: { fields: DiffField[]; addedNodes?: any[]; removedNodes?: any[]; movedNodes?: any[]; changedFields?: any[] };
  rejection: { deleteIssueKeys: string[]; recreateCount: number };
  restoreHistory: any[];
};
