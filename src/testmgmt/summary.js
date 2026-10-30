import { contentDigest } from './content.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/** Both downloads are views of this stored snapshot; no client-provided data enters it. */
export function renderExecutionSummary(record) {
  const { snapshot, digest, summaryId } = record;
  const filename = `execution-${snapshot.execution.key}-${summaryId}`;
  const rows = snapshot.runs.map(run => run.hidden
    ? '<tr><td colspan="6">Unavailable test — content omitted</td></tr>'
    : `<tr><td>${escape(run.test.key)} — ${escape(run.test.summary)}</td><td>v${escape(run.version.versionNo)}</td><td>${escape(run.configuration)} / ${escape(run.environment)} / ${escape(run.release?.name ?? '')}</td><td>${escape(run.state)}</td><td>${escape(run.result)}</td><td>${escape(run.problems.join(', ') || 'Verified record')}</td></tr>`).join('');
  const details = snapshot.runs.filter(run => !run.hidden).map(run => `<section><h2>${escape(run.test.key)} v${escape(run.version.versionNo)}</h2><p>${escape(run.version.content.objective)}</p><pre>${escape(JSON.stringify({ definition: run.version.content, expandedSteps: run.resolvedSteps, results: run.steps, iterations: run.iterations, planningSnapshot: run.planningSnapshot, signatures: run.signatures, notExecutedSignatures: run.notExecutedSignatures }, null, 2))}</pre></section>`).join('');
  const human = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Execution summary ${escape(snapshot.execution.key)}</title><style>body{font:15px system-ui;max-width:1100px;margin:32px auto;padding:0 24px;color:#172b4d}table{border-collapse:collapse;width:100%}th,td{border:1px solid #b3b9c4;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f7;padding:16px}h1{font-size:28px}</style><h1>${escape(snapshot.execution.key)} — ${escape(snapshot.execution.summary)}</h1><p><strong>${escape(snapshot.completeness)}</strong> · Generated ${escape(new Date(snapshot.generatedAt).toISOString())}</p><p>Snapshot SHA-256: <code>${escape(digest)}</code></p><p>${escape(snapshot.problems.join(', ') || 'All included records and evidence were verified at generation time.')}</p><table><thead><tr><th>Test</th><th>Version</th><th>Context</th><th>State</th><th>Result</th><th>Record checks</th></tr></thead><tbody>${rows}</tbody></table>${details}<section><h2>Coverage at generation</h2><pre>${escape(JSON.stringify(snapshot.coverage, null, 2))}</pre></section></html>`;
  // Keep resolver JSON compact to reduce response size. The HTML download
  // retains indented pre blocks for browser reading.
  return { json: { filename: `${filename}.json`, mimeType: 'application/json', content: JSON.stringify({ summaryId, digest, snapshot }) },
    human: { filename: `${filename}.html`, mimeType: 'text/html', content: human } };
}
export const summaryDigestValid = record => !!record?.snapshot && contentDigest(record.snapshot) === record.digest;
