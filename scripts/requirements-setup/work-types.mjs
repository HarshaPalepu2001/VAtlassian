#!/usr/bin/env node
/**
 * Create global Source Document and Requirements work types and workflows.
 *
 * Source Document moves through Registered, Current and Superseded.
 * Requirements moves through Draft, In Review, Baselined, Released or Obsolete.
 *
 *   node scripts/requirements-setup/work-types.mjs            # DRY RUN, read-only
 *   node scripts/requirements-setup/work-types.mjs --apply    # creates what is missing
 *
 * Do not attach types to projects or change existing schemes. A company-managed
 * project must add each type to its scheme and map the corresponding workflow.
 *
 * Create statuses, transitions, va-gate on every transition, Jira editing and
 * attachment locks, and the signature screen on signed transitions. Field
 * validators and rework/retire screens are added with fields by setup.mjs.
 *
 * Share state.mjs's created-object ledger with setup.mjs. Require
 * .out/inspect.json from inspect.mjs for the va-gate validator key.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from './jira.mjs';
import { PLAN } from './plan.mjs';
import { OUT, openLedger, isPending } from './state.mjs';

const APPLY = process.argv.includes('--apply');
const jira = createClient({ write: APPLY });
const log = (s) => console.log(s);
const { file: stateFile, createdId, record, ensure } = openLedger(jira, { apply: APPLY, log });
const lc = (s) => String(s).trim().toLowerCase();

const inspectFile = join(OUT, 'inspect.json');
if (!existsSync(inspectFile)) throw new Error('Run inspect.mjs first.');
const inspect = JSON.parse(readFileSync(inspectFile, 'utf8'));
if (inspect.site !== jira.site) throw new Error(`inspect.json is for ${inspect.site}, not ${jira.site}. Re-run inspect.mjs.`);

log(`${APPLY ? 'APPLYING' : 'DRY RUN (read-only)'} on ${jira.site}\n`);

// ── Facts read from the site ───────────────────────────────────────────────
const vaGateKey = (() => {
  for (const w of inspect.workflows ?? []) for (const t of w.transitions) for (const v of t.validators ?? []) {
    if (v.ruleKey === 'forge:expression-validator' && String(v.parameters?.key).endsWith('/static/va-gate')) return v.parameters.key;
  }
  throw new Error('No va-gate validator found on the governed project workflows in inspect.json.');
})();
log(`va-gate validator: ${vaGateKey.split('/').slice(-3).join('/')}`);

const allFields = await jira.get('/rest/api/3/field');
const sigCandidates = allFields.filter((f) => f.custom && lc(f.name) === lc(PLAN.signatureFieldName) && String(f.schema?.custom).includes('/static/va-approval-field'));
if (sigCandidates.length !== 1) throw new Error(`Expected exactly one VAtlassian "${PLAN.signatureFieldName}" field, found ${sigCandidates.length}.`);
const sigField = sigCandidates[0].id;
const sigContexts = await jira.all(`/rest/api/3/field/${sigField}/context`);
if (!sigContexts.some((c) => c.isGlobalContext && c.isAnyIssueType)) {
  throw new Error(`"${PLAN.signatureFieldName}" (${sigField}) has no global, all-types context, so it would not reach these work types everywhere.`);
}
log(`Signature field: ${sigField} (global, all work types)`);

// ── 1. Work types ──────────────────────────────────────────────────────────
log('\n1. Work types (global)');
const issueTypes = await jira.get('/rest/api/3/issuetype');
const typeId = {};
for (const [key, def] of [['sourceDocument', PLAN.sourceDocument.issueType], ['requirements', PLAN.issueType]]) {
  typeId[key] = await ensure('issueType', def.name, {
    existing: async () => {
      const t = issueTypes.find((x) => lc(x.name) === lc(def.name) && !x.scope);
      if (t && t.hierarchyLevel !== 0) throw new Error(`Work type "${t.name}" exists at hierarchy level ${t.hierarchyLevel}, not a standard type.`);
      return t;
    },
    create: async () => (await jira.post('/rest/api/3/issuetype', { name: def.name, description: def.description, hierarchyLevel: 0 })).id
  });
}

// ── 2. Signature screen ────────────────────────────────────────────────────
log('\n2. Signature screen');
const sigScreenName = PLAN.signatureScreenName;
const sigScreen = await ensure('screen', sigScreenName, {
  existing: async () => (await jira.all(`/rest/api/3/screens?queryString=${encodeURIComponent(sigScreenName)}`)).find((s) => s.name === sigScreenName),
  create: async () => (await jira.post('/rest/api/3/screens', { name: sigScreenName, description: 'VAtlassian electronic signature, shown on every signed transition.' })).id
});
if (isPending(sigScreen)) {
  log(`          fields: ${PLAN.signatureFieldName} (${sigField})`);
} else {
  let tabs = await jira.get(`/rest/api/3/screens/${sigScreen}/tabs`);
  if (!tabs.length && APPLY) tabs = [await jira.post(`/rest/api/3/screens/${sigScreen}/tabs`, { name: 'Signature' })];
  const have = tabs.length ? new Set((await jira.get(`/rest/api/3/screens/${sigScreen}/tabs/${tabs[0].id}/fields`)).map((x) => x.id)) : new Set();
  if (!have.has(sigField)) {
    if (APPLY) await jira.post(`/rest/api/3/screens/${sigScreen}/tabs/${tabs[0].id}/fields`, { fieldId: sigField });
    log(`  ${APPLY ? 'added' : 'ADD'}   ${PLAN.signatureFieldName} to the screen`);
  }
}

// ── 3. Workflows (global) ──────────────────────────────────────────────────
const siteStatuses = await jira.all('/rest/api/3/statuses/search?');
const gate = () => ({ ruleKey: 'forge:expression-validator', parameters: { key: vaGateKey, config: JSON.stringify({ configuredIn: 'admin' }), id: randomUUID() } });

// A dry run validates before our screen exists by standing in VAT's existing
// signature screen (validation is read-only; the stand-in is never saved).
const standIn = inspect.transitionScreens?.find((s) => s.fields.some((f) => f.id === sigField))?.id;
const screenForPayload = isPending(sigScreen) ? standIn : sigScreen;

async function ensureWorkflow({ name, description, statuses, transitions, layout }) {
  log(`\n3. Workflow "${name}"`);
  const ref = {};
  const statusPayload = statuses.map((s) => {
    ref[s.key] = randomUUID();
    const existing = siteStatuses.find((x) => lc(x.name) === lc(s.name) && x.scope?.type === 'GLOBAL');
    if (existing && existing.statusCategory !== s.statusCategory) {
      throw new Error(`Existing status "${s.name}" is ${existing.statusCategory}, plan wants ${s.statusCategory}.`);
    }
    log(`  ${existing ? 'reuse ' : 'CREATE'}  status "${s.name}"${existing ? ` (${existing.id})` : ''}${s.editable ? '' : ', not editable'}${s.lockAttachments ? ', attachments locked' : ''}`);
    return { statusReference: ref[s.key], name: s.name, statusCategory: s.statusCategory, description: '', ...(existing ? { id: existing.id } : {}) };
  });
  const wfTransitions = [{
    id: '1', name: 'Create', type: 'INITIAL', toStatusReference: ref[statuses[0].key], links: [], actions: [], properties: {},
    validators: [{ ruleKey: 'system:check-permission-validator', parameters: { permissionKey: 'CREATE_ISSUES' } }]
  }];
  transitions.forEach((t, i) => {
    wfTransitions.push({
      id: String(11 + i * 10), name: t.name, type: 'DIRECTED', toStatusReference: ref[t.to],
      links: t.from.map((k) => ({ fromStatusReference: ref[k] })),
      validators: [gate()], actions: [], properties: {},
      ...(t.controlled ? { transitionScreen: { ruleKey: 'system:transition-screen', parameters: { screenId: String(screenForPayload) } } } : {})
    });
    log(`  transition "${t.name}": ${t.from.join('/')} → ${t.to}${t.controlled ? ` [signature screen; VAtlassian-controlled: ${t.controlled.role}${t.controlled.captureBaseline ? ', capture baseline' : ''}]` : ''}`);
  });
  const payload = {
    scope: { type: 'GLOBAL' },
    statuses: statusPayload,
    workflows: [{
      name, description,
      startPointLayout: { x: -150, y: 0 },
      statuses: statuses.map((s) => ({
        statusReference: ref[s.key],
        layout: { x: layout[s.key][0], y: layout[s.key][1] },
        properties: {
          ...(s.editable ? {} : { 'jira.issue.editable': 'false' }),
          ...(s.lockAttachments ? { 'jira.permission.attachdeleteall.denied': 'true', 'jira.permission.attachdeleteown.denied': 'true' } : {})
        }
      })),
      transitions: wfTransitions
    }]
  };

  const existingWf = (await jira.get(`/rest/api/3/workflows/search?queryString=${encodeURIComponent(name)}`)).values?.find((w) => w.name === name);
  if (existingWf) {
    const id = existingWf.id ?? existingWf.workflowId;
    if (createdId('workflow', name) !== id) throw new Error(`Workflow "${name}" exists but this setup did not create it.`);
    log(`  ok      workflow (created earlier by this setup)`);
    return id;
  }
  if (!screenForPayload) throw new Error('No screen to validate the signed transitions against.');
  if (!APPLY) writeFileSync(join(OUT, `workflow.${lc(name).replace(/[^a-z0-9]+/g, '-')}.preview.json`), JSON.stringify(payload, null, 2));
  const v = await jira.post('/rest/api/3/workflows/create/validation', { payload, validationOptions: { levels: ['ERROR', 'WARNING'] } });
  for (const e of v.errors ?? []) log(`  ${e.level}: ${e.message} ${JSON.stringify(e.elementReference ?? {})}`);
  if ((v.errors ?? []).some((e) => e.level === 'ERROR')) throw new Error(`Workflow "${name}" failed validation; it was not created.`);
  log(`  validation: passed${isPending(sigScreen) ? ` (signed transitions checked against stand-in screen ${standIn})` : ''}`);
  if (!APPLY) { log('  CREATE  workflow'); return null; }
  const res = await jira.post('/rest/api/3/workflows/create', payload);
  const wf = res.workflows?.[0];
  record('workflow', wf.id, name);
  for (const st of res.statuses ?? []) {
    // Only statuses that did not exist before this call; Jira echoes reused ones too.
    if (!siteStatuses.some((x) => String(x.id) === String(st.id))) record('status', st.id, st.name);
  }
  log(`  created workflow (${wf.id})`);
  return wf.id;
}

await ensureWorkflow({
  name: PLAN.sourceDocument.workflowName,
  description: 'VAtlassian Source Document lifecycle. Current and Superseded are frozen; va-gate on every transition; signatures are configured in VAtlassian.',
  statuses: PLAN.sourceDocument.statuses,
  transitions: PLAN.sourceDocument.transitions,
  layout: PLAN.sourceDocument.layout
});
await ensureWorkflow({
  name: PLAN.requirementsWorkflowName,
  description: 'VAtlassian Requirements lifecycle. Baselined and Released change only through an authorised revision; va-gate on every transition holds drifted items; signatures are configured in VAtlassian.',
  statuses: PLAN.statuses,
  transitions: PLAN.transitions,
  layout: PLAN.requirementsLayout
});

log(`\n${APPLY ? 'Done.' : 'Dry run complete. Nothing was changed.'} Ledger: ${stateFile}`);
