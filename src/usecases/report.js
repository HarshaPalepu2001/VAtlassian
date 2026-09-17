import { load, respond, fail, filterViewableTree, filterViewableReviewDiff } from './panelAccess.js';
import { getReport, putReport } from '../db/reportStore.js';
import { generateReport, reportHashFor, chooseModel, degraded } from '../lib/report.js';
import { sha256Hex, canonical } from '../lib/hash.js';

async function reportFor(args, generate) {
  const state = await load(args, { requireAuthority: generate });
  if (!state.baseline) fail('NO_BASELINE');
  const viewableTree = state.tree ? await filterViewableTree(state.tree) : state.tree;
  const diff = state.reviewDiff ? filterViewableReviewDiff(state.reviewDiff, viewableTree) : state.diff;
  if (!diff) return { report: null, reportHash: null };
  const models = state.config.ai.models;
  const model = state.config.ai.enabled ? chooseModel(diff, models) : 'rule-based';
  // Include the current evidence, even if its collector event has not arrived.
  const reportHash = sha256Hex(canonical({ receipt: reportHashFor(state.baseline,
    diff.fields.flatMap(f => f.driftIds ?? []), model), evidence: state.evidenceHash }));
  const cached = await getReport(reportHash);
  if (cached) return { report: { ...cached.body, ...cached, body: cached.body } };
  if (!generate) return { report: null, reportHash };
  const generated = state.config.ai.enabled ? await generateReport({ issue: state.issue,
    baseline: state.baseline, diff, models, maxCompletionTokens: state.config.ai.maxCompletionTokens })
    : degraded(diff, model, 'DISABLED');
  const result = { ...generated, reportHash, issueId: state.issueId,
    baselineId: state.baseline.baseline_id, now: Date.now() };
  await putReport(result);
  return { report: { ...generated.body, ...generated, reportHash, generatedAt: result.now } };
}
export async function get(args) { return respond(() => reportFor(args, false)); }
export async function generate(args) { return respond(() => reportFor(args, true)); }
