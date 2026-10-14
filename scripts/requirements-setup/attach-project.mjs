#!/usr/bin/env node
/**
 * Brings the global VAtlassian work types (work-types.mjs) into an existing
 * company-managed project:
 *
 *   1. adds Source Document and Requirements to the project's work type scheme;
 *   2. maps each to its VAtlassian workflow in the project's workflow scheme
 *      (through a draft, published — the types have no work items, so nothing
 *      migrates).
 *
 *   node scripts/requirements-setup/attach-project.mjs --project VAT            # DRY RUN
 *   node scripts/requirements-setup/attach-project.mjs --project VAT --apply
 *
 * SAFETY RULES
 *  - Only schemes used by this ONE project are changed; a shared scheme stops
 *    the run (changing it would reach other projects).
 *  - Existing mappings are never replaced: a type already mapped to another
 *    workflow stops the run.
 *  - A pending workflow-scheme draft (someone else's unpublished edit) stops
 *    the run.
 *  - Every change is written to the ledger as a `schemeChange` with what it
 *    replaced, so it can be undone by hand.
 */
import { createClient } from './jira.mjs';
import { PLAN } from './plan.mjs';
import { openLedger } from './state.mjs';

const APPLY = process.argv.includes('--apply');
const projectKey = process.argv[process.argv.indexOf('--project') + 1];
if (!process.argv.includes('--project') || !projectKey || projectKey.startsWith('--')) throw new Error('Usage: attach-project.mjs --project <KEY> [--apply]');
const jira = createClient({ write: APPLY });
const log = (s) => console.log(s);
const { file: stateFile, createdId, record } = openLedger(jira, { apply: APPLY, log });

log(`${APPLY ? 'APPLYING' : 'DRY RUN (read-only)'} on ${jira.site} — project ${projectKey}\n`);

const project = await jira.get(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
if (project.style !== 'classic') throw new Error(`${projectKey} is team-managed; global work types and workflows cannot be used there.`);

const WANT = [
  { name: PLAN.sourceDocument.issueType.name, workflow: PLAN.sourceDocument.workflowName },
  { name: PLAN.issueType.name, workflow: PLAN.requirementsWorkflowName }
].map((w) => {
  const id = createdId('issueType', w.name);
  if (!id) throw new Error(`Work type "${w.name}" is not in the ledger. Run work-types.mjs --apply first.`);
  if (!createdId('workflow', w.workflow)) throw new Error(`Workflow "${w.workflow}" is not in the ledger. Run work-types.mjs --apply first.`);
  return { ...w, id };
});

// Which projects use a scheme. These endpoints only report the projects asked
// about, so ask about every company-managed project.
const classicIds = (await jira.all('/rest/api/3/project/search')).filter((p) => p.style === 'classic').map((p) => p.id);
async function schemeUsers(kind, schemeId) {
  const users = [];
  for (let i = 0; i < classicIds.length; i += 50) {
    const q = classicIds.slice(i, i + 50).map((id) => `projectId=${id}`).join('&');
    const rows = kind === 'issueTypeScheme'
      ? await jira.all(`/rest/api/3/issuetypescheme/project?${q}`)
      : (await jira.get(`/rest/api/3/workflowscheme/project?${q}`)).values;
    for (const r of rows) if (String((r.issueTypeScheme ?? r.workflowScheme).id) === String(schemeId)) users.push(...r.projectIds);
  }
  return [...new Set(users.map(String))];
}

// ── 1. Work type scheme ────────────────────────────────────────────────────
log('1. Work type scheme');
const itsLink = (await jira.get(`/rest/api/3/issuetypescheme/project?projectId=${project.id}`)).values?.[0];
if (!itsLink) throw new Error(`No work type scheme found for ${projectKey}.`);
const its = itsLink.issueTypeScheme;
const itsUsers = await schemeUsers('issueTypeScheme', its.id);
if (itsUsers.length !== 1) throw new Error(`Work type scheme "${its.name}" is shared by ${itsUsers.length} projects; not changing it.`);
const itsTypes = (await jira.all(`/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=${its.id}`)).map((m) => String(m.issueTypeId));
const toAdd = WANT.filter((w) => !itsTypes.includes(w.id));
for (const w of WANT) log(`  ${itsTypes.includes(w.id) ? 'ok    ' : APPLY ? 'add   ' : 'ADD   '}  "${w.name}" (${w.id}) → "${its.name}" (${its.id})`);
if (toAdd.length && APPLY) {
  await jira.put(`/rest/api/3/issuetypescheme/${its.id}/issuetype`, { issueTypeIds: toAdd.map((w) => w.id) });
  for (const w of toAdd) record('schemeChange', its.id, `${projectKey}: issueTypeScheme`, { detail: `added ${w.id} (${w.name})`, undo: `remove work type ${w.id} from work type scheme ${its.id}` });
}

// ── 2. Workflow scheme ─────────────────────────────────────────────────────
log('\n2. Workflow scheme');
const wsLink = (await jira.get(`/rest/api/3/workflowscheme/project?projectId=${project.id}`)).values?.[0];
if (!wsLink) throw new Error(`No workflow scheme found for ${projectKey}.`);
const wsUsers = await schemeUsers('workflowScheme', wsLink.workflowScheme.id);
if (wsUsers.length !== 1) throw new Error(`Workflow scheme "${wsLink.workflowScheme.name}" is shared by ${wsUsers.length} projects; not changing it.`);
const wsId = wsLink.workflowScheme.id;
const ws = await jira.get(`/rest/api/3/workflowscheme/${wsId}`);
const mapping = ws.issueTypeMappings ?? {};
const toMap = [];
for (const w of WANT) {
  const current = mapping[w.id];
  if (current === w.workflow) { log(`  ok      "${w.name}" → "${w.workflow}"`); continue; }
  if (current) throw new Error(`"${w.name}" is already mapped to "${current}" in "${ws.name}"; not replacing it.`);
  log(`  ${APPLY ? 'map   ' : 'MAP   '}  "${w.name}" → "${w.workflow}" (default today: "${ws.defaultWorkflow}")`);
  toMap.push(w);
}
if (toMap.length) {
  // Jira asks where items in the old workflow's statuses go. Safe to answer
  // "the new workflow's start status" only because no items exist yet.
  const count = (await jira.post('/rest/api/3/search/jql', { jql: `project = ${projectKey} AND issuetype in (${toMap.map((w) => w.id).join(',')})`, maxResults: 1, fields: ['id'] })).issues?.length ?? 0;
  if (count) throw new Error(`${projectKey} already has work items of these types; their statuses need a deliberate migration. Stopping.`);
  const wfs = await jira.post('/rest/api/3/workflows', { workflowNames: [ws.defaultWorkflow, ...toMap.map((w) => w.workflow)] });
  const statusesOf = (name) => {
    const wf = wfs.workflows.find((x) => x.name === name);
    const byRef = Object.fromEntries((wfs.statuses ?? []).map((st) => [st.statusReference, String(st.id)]));
    return { all: wf.statuses.map((st) => byRef[st.statusReference]), start: byRef[wf.transitions.find((t) => t.type === 'INITIAL').toStatusReference] };
  };
  const from = statusesOf(ws.defaultWorkflow).all;
  const statusMappings = [];
  for (const w of toMap) {
    const to = statusesOf(w.workflow);
    for (const st of from.filter((x) => !to.all.includes(x))) statusMappings.push({ issueTypeId: w.id, statusId: st, newStatusId: to.start });
    log(`          no "${w.name}" items exist; status mapping (required by Jira) → start status ${to.start}`);
  }
  if (APPLY) {
    const draft = await jira.find(`/rest/api/3/workflowscheme/${wsId}/draft`);
    const expected = { ...mapping, ...Object.fromEntries(toMap.map((w) => [w.id, w.workflow])) };
    if (draft) {
      const same = JSON.stringify(Object.entries(draft.issueTypeMappings ?? {}).sort()) === JSON.stringify(Object.entries(expected).sort()) && draft.defaultWorkflow === ws.defaultWorkflow;
      if (!same) throw new Error(`"${ws.name}" already has an unpublished draft that is not this change; publish or discard it first.`);
      log('          reusing the unpublished draft from an earlier run (same mappings)');
    } else {
      await jira.post(`/rest/api/3/workflowscheme/${wsId}/createdraft`);
      for (const w of toMap) await jira.put(`/rest/api/3/workflowscheme/${wsId}/draft/issuetype/${w.id}`, { issueType: w.id, workflow: w.workflow });
    }
    const task = await jira.post(`/rest/api/3/workflowscheme/${wsId}/draft/publish?validateOnly=false`, { statusMappings });
    const done = await waitForTask(task);
    if (done && done.status !== 'COMPLETE') throw new Error(`Publishing the draft ended ${done.status}: ${JSON.stringify(done.result ?? done.message ?? '')}`);
  }
}
if (toMap.length && APPLY) {
  const after = (await jira.get(`/rest/api/3/workflowscheme/${wsId}`)).issueTypeMappings ?? {};
  for (const w of toMap) {
    if (after[w.id] !== w.workflow) throw new Error(`After publishing, "${w.name}" maps to "${after[w.id] ?? ws.defaultWorkflow}", not "${w.workflow}".`);
    record('schemeChange', wsId, `${projectKey}: workflowScheme`, { detail: `mapped ${w.id} (${w.name}) → ${w.workflow}`, undo: `remove the ${w.id} mapping from workflow scheme ${wsId} (falls back to "${ws.defaultWorkflow}")` });
    log(`  mapped  "${w.name}" → "${w.workflow}"`);
  }
}

async function waitForTask(task) {
  const id = task?.id ?? task?.taskId ?? String(task?.self ?? '').split('/').pop();
  if (!id) return null; // published synchronously
  for (let i = 0; i < 60; i++) {
    const t = await jira.get(`/rest/api/3/task/${id}`);
    if (['COMPLETE', 'FAILED', 'CANCELLED', 'DEAD'].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Publish task ${id} did not finish in time.`);
}

log(`\n${APPLY ? 'Done.' : 'Dry run complete — nothing was changed.'} Ledger: ${stateFile}`);
log(`\nStill to do in VAtlassian administration for ${projectKey}:`);
for (const t of [...PLAN.sourceDocument.transitions.map((t) => ({ ...t, type: PLAN.sourceDocument.issueType.name })), ...PLAN.transitions.filter((t) => t.controlled).map((t) => ({ ...t, type: PLAN.issueType.name }))]) {
  log(`  - ${t.type}: "${t.name}" (${t.from.join('/')} → ${t.to}) controlled, role ${t.controlled.role}${t.controlled.captureBaseline ? ', capture baseline' : ''}`);
}
