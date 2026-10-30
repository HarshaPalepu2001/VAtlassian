import type { AssuranceLevel } from '../lib/assurance';
import type { DiffField, ReviewGroup } from '../review/types';

/** One controlled, gated transition described for every viewer. `canApprove` is the only field that varies by viewer;
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
  /** Set when this baseline was written by its parent's capture: "Baselined with PARENT-1 v3". */
  capturedBy?: { issueKey: string | null; version: number } | null;
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
  jobId?: string | null;
  queuedAt?: number | null;
  /** When it stopped, restored or not; null while it is still running. */
  finishedAt?: number | null;
  /** The baseline version it puts the work item back to. */
  baselineVersion?: number | null;
  heartbeatAt?: number | null;
  totalSteps?: number;
  completedSteps?: number;
  lastCheckpoint?: number | null;
  lastError?: string | null;
};

/** The compact `panel:getSummary` response for the initial panel display. Never carries recursive tree detail, retained values,
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
  /** `eligible` is this viewer's standing on the baseline, answered independently
   *  of any drift count, so the client can pair it with the count it displays. */
  drift: { count: number; materialCount: number; decidesDrift: boolean; policyIncomplete: boolean; canApprove: boolean; canReject: boolean; eligible?: boolean;
    /** Descendants drifted against their own baselines. A parent decision covers them; they do not hold the parent. */
    childrenAwaiting?: number;
    heldBy?: { issueKey: string; issueId: number; depth: number } | null;
    /** Links approved on the other issue, on their way to this record (jobs/linkWorker.js). */
    linkPending?: { decidedOnKey: string; queuedAt: number }[] };
  /** Hash of the tracked content right now; moves on every edit. */
  contentHash?: string | null;
  restore: PanelRestore | null;
  /** The latest restore of ANOTHER work item that wrote to this one: a parent's
   *  rejection puts each child back to its own record, under the parent's signature. */
  restoredVia?: { restoreId: string; parentIssueId: number; parentIssueKey: string | null; state: string; finishedAt: number | null; baselineVersion: number | null } | null;
  approval: { requiredRole?: string | null; requiredAssurance?: AssuranceLevel | null; meaning?: string | null; pending: PendingApproval | null };
  adminIncidentCount?: number;
  adminIncidentUnavailable?: boolean;
  error?: string;
  /** The review row's version counter increments on every re-observation,
   *  independently of baseline.version. Passed to usePanelEvidence so it can key
   *  its cache on the current-record evidence itself, not only the baseline. */
  evidenceVersion?: number | null;
};

export type BaselineField = { fieldId: string; fieldName: string; materiality?: string; retained: boolean; digest?: string; preview?: { text?: string; empty?: boolean; truncated?: boolean; more?: number } | null };
export type BaselineRecordData = { version: number; approvedName?: string; approvedAt?: number; capturedAt?: number; assuranceLevel?: AssuranceLevel; fidelity?: string; contentHash?: string; fieldCount: number; retainedCount: number; fields: BaselineField[]; history?: { version: number; approvedName?: string; approvedAt?: number; assuranceLevel?: AssuranceLevel }[] };

/** One file a rejection acts on, with the work item it is attached to. */
export type RejectedFile = { issueId: number | null; issueKey: string | null; id: string; filename: string; reason?: string };
/** What a rejection does to files: deleted, re-uploaded from the vault, or beyond restoring. */
export type AttachmentRejection = { deleteFiles: RejectedFile[]; restoreFiles: RejectedFile[]; unrestorableFiles: RejectedFile[]; mediaUnknownFiles?: RejectedFile[]; vaultChecked: boolean };

/** The heavy, authoritative current-record read from `panel:getEvidence`. Rejected server-side
 *  as STALE_EVIDENCE when the caller's expected baseline id/version no longer
 *  matches the latest active baseline. See usePanelEvidence.ts. */
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
  drift: { count: number; materialCount: number; fields: DiffField[]; groups?: ReviewGroup[];
    /** Whether this review can be decided field by field (never for a structural change), and why not. */
    mixed?: { eligible: boolean; reason: string | null; fields: { fieldId: string; restorable: string | null; retained: boolean }[] };
    historyTruncated?: boolean; historyUnavailable?: boolean; addedNodes?: any[]; removedNodes?: any[]; movedNodes?: any[]; changedFields?: any[] };
  rejection: { deleteIssueKeys: string[]; recreateCount: number; attachments?: AttachmentRejection | null };
  restoreHistory: any[];
};
