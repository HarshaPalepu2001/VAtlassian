export type ChainStep = { label: string; role: string; meaning: string };
export type Chain = { steps: ChainStep[]; distinctSigners: boolean };
export type Signature = { stepIndex: number; label: string; role: string; decision: string; printedName: string;
  signedAt: number; reason: string | null; meaning: string; assuranceLevel: string; contentHash: string };
export type NextStep = (ChainStep & { index: number }) | null;

export type Step = { id: string; action: string; data: string; expected: string };
export type Draft = { objective: string; preconditions: string; steps: Step[]; verifies: { issueId: string; issueKey: string }[]; dataset?: import('./DatasetEditor').Dataset | null;
  revision: number; updatedAt?: number };
export type Version = { versionId: string; versionNo: number; state: string; digest: string; publishedAt: number;
  sourceLinks?: { state: string; problem?: string | null };
  signedAt: number | null; content: { objective: string; preconditions: string; steps: Step[]; verifies?: Partial<import('./CoverageView').SourceReference>[]; dataset?: import('./DatasetEditor').Dataset | null }; chain: Chain; canFinishVersion?: boolean;
  signatures: Signature[]; nextStep: NextStep; canSign: boolean; authors?: string[]; signBlocked?: string | null };
export type Parent = { id: string; key: string; summary: string | null } | null;
export type TestViewModel = { role: 'TEST'; issue: { id: string; key: string; summary: string }; parent: Parent;
  canEdit: boolean; draft: Draft; versions: Version[];
  runs: { runId: string; executionIssueId: string; state: string; result: string; createdAt: number }[] };

export type Evidence = { attachmentId: string; filename: string; size: number; sha256: string };
/** What a recorded step said before it was changed, who changed it and why. */
export type StepChange = { kind: 'RESULT' | 'EVIDENCE_REMOVED'; status?: string; actual?: string; comment?: string; recordedBy?: string | null;
  evidence?: { attachmentId: string; sha256: string } | null; changedBy: string; changedAt: number; reason: string };
export type RunStep = { id: string; position: number; action: string; data: string; expected: string; status: string;
  actual: string; comment: string; evidence: Evidence[]; recordedBy: string | null; history?: StepChange[] };
export type Bug = { state: string; issueKey: string | null; lastError: string | null } | null;
export type Run = { runId: string; state: string; result: string; revision: number; resultPending?: boolean;
  iterations?: { id: string; values: Record<string, string>; stepIds?: string[] }[];
  planningSnapshot?: { plan?: { issueId: string; revisionId: string; revisionNo: number; digest: string }; preconditions?: { issueId: string; revisionNo: number; text: string }[] } | null;
  test: { id: string; key: string | null; summary: string | null; hidden: boolean }; version: { versionId: string; versionNo: number | null; digest: string };
  environment: string; configuration: string; release: { id: string; name: string } | null; retestOf: string | null;
  createdAt: number; steps: RunStep[]; preconditions: string; contentHash: string; signabilityProblem: string | null;
  chain: Chain; signatures: Signature[]; notExecuted: { reason: string; printedName: string; signedAt: number } | null;
  nextStep: NextStep; canSign: boolean; bug: Bug; canFinish: boolean };
export type ExecutionViewModel = { role: 'EXECUTION'; issue: { id: string; key: string; summary: string; status: string; done: boolean };
  parent: Parent; canEdit: boolean; releases: { id: string; name: string }[];
  attachments: { id: string; filename: string; size: number }[]; runChain: Chain; runs: Run[] };

export type Failure = { error?: string; reason?: string };
