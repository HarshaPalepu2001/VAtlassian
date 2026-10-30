#!/usr/bin/env node
/**
 * Brings the test-management work types of plan.mjs into one company-managed
 * project, each with its own fields, screens and workflow:
 *
 *   1. the six work types, GLOBAL, with their icons;
 *   2. added to the project's work type scheme;
 *   3. the test custom fields: new ones scoped to this project and the types
 *      that use them, existing global ones (Severity, Root cause) referenced;
 *   4. create / edit / view screens per type, and the transition screens;
 *   5. a screen scheme per type, mapped in the project's work type screen scheme;
 *   6. the new fields associated with the project;
 *   7. a workflow per type, GLOBAL, va-gate on every transition (so the
 *      execution guard holds every route into Done);
 *   8. each type mapped to its workflow in the project's workflow scheme
 *      (draft, published; existing items keep a status of the same name, or
 *      move to the nearest status of the same category);
 *   9. read-back: every type on its own screen scheme and workflow, every
 *      Execution route into Done carrying va-gate;
 *  10. with --link-types only: the six test link types.
 *
 *   node scripts/test-management-setup/setup.mjs --project VAT                 # DRY RUN
 *   node scripts/test-management-setup/setup.mjs --project VAT --apply
 *   node scripts/test-management-setup/setup.mjs --project VAT --link-types [--apply]
 *
 * Same credentials, safety rules and created-object ledger as the
 * requirements setup (scripts/requirements-setup/README.md): an object of a
 * planned name that this setup did not create stops the run (statuses and
 * reuseIfGlobal fields are referenced by design), a shared scheme stops the
 * run, a type already mapped to something else is never re-mapped, and every
 * scheme change is recorded with how to undo it.
 *
 * Required fields are not used: VAtlassian creates retest executions and
 * automatic bugs as the app, and a required field it does not fill would make
 * Jira refuse them.
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '../requirements-setup/jira.mjs';
import { openLedger, isPending } from '../requirements-setup/state.mjs';
import { findLinkType } from '../requirements-setup/link-type.mjs';
import { planFieldContext } from '../requirements-setup/field-context.mjs';
import { findCustomFieldsByName, findReusableCustomField } from '../requirements-setup/field-discovery.mjs';
import { fieldAssociationPayload, missingFieldAssociations } from '../requirements-setup/field-association.mjs';
import { PLAN } from './plan.mjs';

const APPLY = process.argv.includes('--apply');
const LINK_TYPES = process.argv.includes('--link-types');
const projectKey = process.argv[process.argv.indexOf('--project') + 1];
if (!process.argv.includes('--project') || !projectKey || projectKey.startsWith('--')) throw new Error('Usage: setup.mjs --project <KEY> [--link-types] [--apply]');
const jira = createClient({ write: APPLY });
const log = (s) => console.log(s);
const { file: stateFile, createdId, record, ensure } = openLedger(jira, { apply: APPLY, log });
const lc = (s) => String(s).trim().toLowerCase();

const FIELD_TYPES = {
  select: ['com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'],
  textarea: ['com.atlassian.jira.plugin.system.customfieldtypes:textarea', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher']
};

log(`${APPLY ? 'APPLYING' : 'DRY RUN (read-only)'} on ${jira.site}, project ${projectKey}`);
log(`Reference: ${PLAN.source}\n`);

// ── Preflight ──────────────────────────────────────────────────────────────
const project = await jira.get(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
if (project.style !== 'classic') throw new Error(`${projectKey} is team-managed; global work types cannot be used there.`);

// Which projects use a scheme. These endpoints only report the projects asked
// about, so ask about every company-managed project.
const classicIds = (await jira.all('/rest/api/3/project/search')).filter((p) => p.style === 'classic').map((p) => p.id);
async function soleUser(kind, schemeId, schemeName) {
  const users = new Set();
  for (let i = 0; i < classicIds.length; i += 50) {
    const q = classicIds.slice(i, i + 50).map((id) => `projectId=${id}`).join('&');
    const rows = kind === 'workflowScheme'
      ? (await jira.get(`/rest/api/3/workflowscheme/project?${q}`)).values
      : await jira.all(`/rest/api/3/${kind.toLowerCase()}/project?${q}`);
    for (const r of rows) if (String((r.issueTypeScheme ?? r.issueTypeScreenScheme ?? r.workflowScheme).id) === String(schemeId)) r.projectIds.forEach((p) => users.add(String(p)));
  }
  if (users.size !== 1) throw new Error(`"${schemeName}" is shared by ${users.size} projects; not changing it.`);
}
const its = (await jira.get(`/rest/api/3/issuetypescheme/project?projectId=${project.id}`)).values?.[0]?.issueTypeScheme;
const itss = (await jira.get(`/rest/api/3/issuetypescreenscheme/project?projectId=${project.id}`)).values?.[0]?.issueTypeScreenScheme;
const wsLink = (await jira.get(`/rest/api/3/workflowscheme/project?projectId=${project.id}`)).values?.[0]?.workflowScheme;
if (!its || !itss || !wsLink) throw new Error(`${projectKey} is missing a work type, screen or workflow scheme.`);
await soleUser('issueTypeScheme', its.id, its.name);
await soleUser('issueTypeScreenScheme', itss.id, itss.name);
await soleUser('workflowScheme', wsLink.id, wsLink.name);

// va-gate, as the project's own default workflow carries it.
const defaultWf = (await jira.post('/rest/api/3/workflows', { workflowNames: [wsLink.defaultWorkflow] })).workflows[0];
const vaGateKey = defaultWf.transitions.flatMap((t) => t.validators ?? [])
  .find((v) => v.ruleKey === 'forge:expression-validator' && String(v.parameters?.key).endsWith('/static/va-gate'))?.parameters.key;
if (!vaGateKey) throw new Error(`"${wsLink.defaultWorkflow}" carries no va-gate validator to copy.`);
log(`va-gate validator: ${vaGateKey.split('/').slice(-3).join('/')}`);
// A dry run validates new transition screens against the project's default screen.
const standInScreen = (await jira.get(`/rest/api/3/screenscheme?id=${(await jira.all(`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`)).find((m) => m.issueTypeId === 'default').screenSchemeId}`)).values[0].screens.default;

// ── 1. Work types ──────────────────────────────────────────────────────────
log('\n1. Work types (global)');
const issueTypes = await jira.get('/rest/api/3/issuetype');
const TYPES = [];
for (const def of PLAN.issueTypes) {
  const id = await ensure('issueType', def.name, {
    existing: async () => {
      const t = issueTypes.find((x) => lc(x.name) === lc(def.name) && !x.scope);
      if (t && t.hierarchyLevel !== 0) throw new Error(`Work type "${t.name}" exists at hierarchy level ${t.hierarchyLevel}, not a standard type.`);
      return t;
    },
    create: async () => (await jira.post('/rest/api/3/issuetype', { name: def.name, description: def.description, hierarchyLevel: 0 })).id
  });
  TYPES.push({ ...def, id });
  // Set apart from create, so a failed icon change never loses a created id.
  if (isPending(id)) { log(`          icon: system icon ${def.avatarId}`); continue; }
  const live = await jira.get(`/rest/api/3/issuetype/${id}`);
  if (Number(live.avatarId) !== def.avatarId) {
    if (APPLY) await jira.put(`/rest/api/3/issuetype/${id}`, { avatarId: def.avatarId });
    log(`  ${APPLY ? 'icon  ' : 'ICON  '}  "${def.name}" → system icon ${def.avatarId}`);
  }
}

// ── 2. Work type scheme ────────────────────────────────────────────────────
log('\n2. Work type scheme');
const itsTypes = (await jira.all(`/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=${its.id}`)).map((m) => String(m.issueTypeId));
const toAdd = TYPES.filter((t) => !itsTypes.includes(t.id));
for (const t of TYPES) log(`  ${itsTypes.includes(t.id) ? 'ok    ' : APPLY ? 'add   ' : 'ADD   '}  "${t.name}" → "${its.name}" (${its.id})`);
if (toAdd.length && APPLY) {
  await jira.put(`/rest/api/3/issuetypescheme/${its.id}/issuetype`, { issueTypeIds: toAdd.map((t) => t.id) });
  for (const t of toAdd) record('schemeChange', its.id, `${projectKey}: issueTypeScheme`, { detail: `added ${t.id} (${t.name})`, undo: `remove work type ${t.id} from work type scheme ${its.id}` });
}

// ── 3. Custom fields ───────────────────────────────────────────────────────
log('\n3. Custom fields');
const fieldId = {};
for (const f of PLAN.fields) {
  const users = TYPES.filter((t) => t.fields.includes(f.key));
  fieldId[f.key] = await ensure('field', f.name, {
    allowForeign: !!f.reuseIfGlobal,
    existing: async () => {
      const matches = f.reuseIfGlobal ? [await findReusableCustomField(jira, f.name)].filter(Boolean) : await findCustomFieldsByName(jira, f.name);
      if (matches.length > 1) throw new Error(`Several custom fields are named "${f.name}" (${matches.map((m) => m.id).join(', ')}).`);
      const m = matches[0];
      if (!m) {
        if (f.reuseIfGlobal) throw new Error(`"${f.name}" was planned as an existing global field, but none was found.`);
        return null;
      }
      if (f.reuseIfGlobal) {
        if (m.schema?.custom !== FIELD_TYPES[f.kind][0]) throw new Error(`Existing "${f.name}" is ${m.schema?.custom}, not ${f.kind}.`);
        const ctx = await jira.all(`/rest/api/3/field/${m.id}/context`);
        if (!ctx.some((c) => c.isGlobalContext && c.isAnyIssueType)) throw new Error(`Existing "${f.name}" (${m.id}) is not global; it would need modifying to reach ${projectKey}.`);
      }
      return m;
    },
    create: async () => {
      const [type, searcherKey] = FIELD_TYPES[f.kind];
      return (await jira.post('/rest/api/3/field', { name: f.name, description: f.description, type, searcherKey })).id;
    }
  });
  if (createdId('field', f.name) || isPending(fieldId[f.key])) await scopeField(f, fieldId[f.key], users);
}

// Jira refuses deleting a default global context (CHANGE-3019): keep it, add
// a project/work-type context for the options, and let the screens decide
// where the field shows.
async function scopeField(f, fid, users) {
  const ctxName = `${projectKey}: Test management`;
  const typeIds = users.map((t) => t.id);
  if (isPending(fid) || typeIds.some(isPending)) { log(`          SCOPE   → ${ctxName} (${users.map((t) => t.name).join(', ')})${f.options ? `; options: ${f.options.join(', ')}` : ''}`); return; }
  const contextPlan = planFieldContext({ contexts: await jira.all(`/rest/api/3/field/${fid}/context`), scopedName: ctxName });
  let ours = contextPlan.scopedContext;
  if (contextPlan.createScopedContext) {
    if (!APPLY) { log(`          SCOPE   → ${ctxName} (${users.map((t) => t.name).join(', ')})`); return; }
    ours = await jira.post(`/rest/api/3/field/${fid}/context`, { name: ctxName, description: 'VAtlassian test management.', projectIds: [String(project.id)], issueTypeIds: typeIds });
    log(`          scoped  → context ${ours.id} (${ctxName})`);
  }
  if (f.options) {
    const have = new Set((await jira.all(`/rest/api/3/field/${fid}/context/${ours.id}/option`)).map((o) => o.value));
    const missing = f.options.filter((o) => !have.has(o));
    if (missing.length && APPLY) await jira.post(`/rest/api/3/field/${fid}/context/${ours.id}/option`, { options: missing.map((value) => ({ value, disabled: false })) });
    if (missing.length) log(`          ${APPLY ? 'added' : 'ADD'}   options: ${missing.join(', ')}`);
  }
}

// ── 4. Screens ─────────────────────────────────────────────────────────────
log('\n4. Screens');
const screenId = {};
const resolve = (token) => (token.startsWith('f:') ? fieldId[token.slice(2)] : token);
for (const t of TYPES) {
  for (const [key, tokens] of Object.entries(t.screens)) {
    const name = PLAN.screenName(t, key);
    screenId[`${t.key}:${key}`] = await ensure('screen', name, {
      existing: async () => (await jira.all(`/rest/api/3/screens?queryString=${encodeURIComponent(name)}`)).find((s) => s.name === name),
      create: async () => (await jira.post('/rest/api/3/screens', { name, description: `VAtlassian ${t.name}.` })).id
    });
    await fillScreen(screenId[`${t.key}:${key}`], tokens);
  }
}

// Adds missing fields to the first tab, in plan order. Never removes one.
async function fillScreen(sid, tokens) {
  const want = tokens.map(resolve);
  if (isPending(sid) || want.some(isPending)) { log(`          fields: ${tokens.join(', ')}`); return; }
  let tabs = await jira.get(`/rest/api/3/screens/${sid}/tabs`);
  if (!tabs.length && APPLY) tabs = [await jira.post(`/rest/api/3/screens/${sid}/tabs`, { name: 'Field Tab' })];
  const have = tabs.length ? new Set((await jira.get(`/rest/api/3/screens/${sid}/tabs/${tabs[0].id}/fields`)).map((x) => x.id)) : new Set();
  const missing = want.filter((fid) => !have.has(fid));
  for (const fid of missing) if (APPLY) await jira.post(`/rest/api/3/screens/${sid}/tabs/${tabs[0].id}/fields`, { fieldId: fid });
  log(missing.length ? `          ${APPLY ? 'added' : 'ADD'}   ${missing.join(', ')}` : '          fields ok');
}

// ── 5. Screen schemes, mapped in the project's work type screen scheme ─────
log('\n5. Screen schemes');
const schemeId = {};
for (const t of TYPES) {
  const name = PLAN.screenSchemeName(t);
  const s = (k) => Number(screenId[`${t.key}:${k}`]);
  schemeId[t.key] = await ensure('screenScheme', name, {
    existing: async () => (await jira.all(`/rest/api/3/screenscheme?queryString=${encodeURIComponent(name)}`)).find((x) => x.name === name),
    create: async () => (await jira.post('/rest/api/3/screenscheme', { name, description: `VAtlassian ${t.name}.`, screens: { default: s('view'), create: s('create'), edit: s('edit'), view: s('view') } })).id
  });
}
log(`\n   Work type screen scheme "${itss.name}" (${itss.id})`);
const itssMappings = await jira.all(`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`);
const ssToMap = [];
for (const t of TYPES) {
  const current = itssMappings.find((m) => String(m.issueTypeId) === t.id);
  if (current && String(current.screenSchemeId) === String(schemeId[t.key])) { log(`  ok      "${t.name}" → "${PLAN.screenSchemeName(t)}"`); continue; }
  if (current) throw new Error(`"${t.name}" is already mapped to screen scheme ${current.screenSchemeId} in "${itss.name}"; not replacing it.`);
  log(`  ${APPLY ? 'map   ' : 'MAP   '}  "${t.name}" → "${PLAN.screenSchemeName(t)}" (default today: ${itssMappings.find((m) => m.issueTypeId === 'default')?.screenSchemeId})`);
  ssToMap.push(t);
}
if (ssToMap.length && APPLY) {
  await jira.put(`/rest/api/3/issuetypescreenscheme/${itss.id}/mapping`, { issueTypeMappings: ssToMap.map((t) => ({ issueTypeId: t.id, screenSchemeId: String(schemeId[t.key]) })) });
  for (const t of ssToMap) record('schemeChange', itss.id, `${projectKey}: issueTypeScreenScheme`, { detail: `mapped ${t.id} (${t.name}) → screen scheme ${schemeId[t.key]}`, undo: `remove the ${t.id} mapping from work type screen scheme ${itss.id} (falls back to its default)` });
}

// ── 6. Field associations ──────────────────────────────────────────────────
// The project-filtered field catalogue is the association oracle (see the
// requirements setup). Only fields this setup created are associated.
log('\n6. Jira field associations');
const ownFields = () => PLAN.fields.filter((f) => createdId('field', f.name)).map((f) => fieldId[f.key]).filter((id) => !isPending(id));
const associationGaps = async () => missingFieldAssociations(ownFields(), { values: await jira.all(`/rest/api/3/field/search?projectIds=${project.id}`) });
let unassociated = await associationGaps();
const pendingFields = PLAN.fields.filter((f) => isPending(fieldId[f.key])).map((f) => f.name);
if (pendingFields.length) log(`  ASSOCIATE ${pendingFields.join(', ')} with ${projectKey} once created`);
if (!unassociated.length) {
  log(`  ok      ${ownFields().length ? 'created fields are associated with the project' : 'no created fields yet'}`);
} else if (!APPLY) {
  log(`  ASSOCIATE ${unassociated.join(', ')} with ${projectKey}`);
} else {
  const associated = [...unassociated];
  await jira.put('/rest/api/3/field/association', fieldAssociationPayload(project.id, unassociated));
  for (let attempt = 0; attempt < 5 && unassociated.length; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000));
    unassociated = await associationGaps();
  }
  if (unassociated.length) throw new Error(`Jira still omits associated fields: ${unassociated.join(', ')}.`);
  record('fieldAssociation', project.id, `${projectKey}: test management`, { detail: `associated ${associated.join(', ')} with project ${projectKey}`, undo: `remove only these field associations from project ${projectKey}` });
  log(`  associated ${associated.join(', ')} with ${projectKey}`);
}

// ── 7. Workflows (global) ──────────────────────────────────────────────────
const siteStatuses = await jira.all('/rest/api/3/statuses/search?');
const gate = () => ({ ruleKey: 'forge:expression-validator', parameters: { key: vaGateKey, config: JSON.stringify({ configuredIn: 'admin' }), id: randomUUID() } });

for (const t of TYPES) {
  const w = t.workflow;
  log(`\n7. Workflow "${w.name}" (${t.name})`);
  const ref = {};
  const statusPayload = w.statuses.map((s) => {
    ref[s.key] = randomUUID();
    const existing = siteStatuses.find((x) => lc(x.name) === lc(s.name) && x.scope?.type === 'GLOBAL');
    if (existing && existing.statusCategory !== s.statusCategory) throw new Error(`Existing status "${s.name}" is ${existing.statusCategory}, plan wants ${s.statusCategory}.`);
    log(`  ${existing ? 'reuse ' : 'CREATE'}  status "${s.name}"${existing ? ` (${existing.id})` : ''} ${s.statusCategory}${s.editable === false ? ', not editable' : ''}`);
    return { statusReference: ref[s.key], name: s.name, statusCategory: s.statusCategory, description: '', ...(existing ? { id: existing.id } : {}) };
  });
  const transitions = [{
    id: '1', name: 'Create', type: 'INITIAL', toStatusReference: ref[w.statuses[0].key], links: [], actions: [], properties: {},
    validators: [{ ruleKey: 'system:check-permission-validator', parameters: { permissionKey: 'CREATE_ISSUES' } }]
  }];
  w.transitions.forEach((tr, i) => {
    const sid = tr.screen ? screenId[`${t.key}:${tr.screen}`] : null;
    transitions.push({
      id: String(11 + i * 10), name: tr.name, type: 'DIRECTED', toStatusReference: ref[tr.to],
      links: tr.from.map((k) => ({ fromStatusReference: ref[k] })),
      validators: [gate()], actions: [], properties: {},
      ...(sid ? { transitionScreen: { ruleKey: 'system:transition-screen', parameters: { screenId: String(isPending(sid) ? standInScreen : sid) } } } : {})
    });
    log(`  transition "${tr.name}": ${tr.from.join('/')} → ${tr.to}${sid ? ` [screen ${PLAN.screenName(t, tr.screen)}]` : ''}`);
  });
  const payload = {
    scope: { type: 'GLOBAL' },
    statuses: statusPayload,
    workflows: [{
      name: w.name, description: w.description,
      startPointLayout: { x: -150, y: 0 },
      statuses: w.statuses.map((s, i) => ({
        statusReference: ref[s.key],
        layout: { x: i * 250, y: 0 },
        properties: s.editable === false ? { 'jira.issue.editable': 'false', 'jira.permission.attachdeleteall.denied': 'true', 'jira.permission.attachdeleteown.denied': 'true' } : {}
      })),
      transitions
    }]
  };
  const existingWf = (await jira.get(`/rest/api/3/workflows/search?queryString=${encodeURIComponent(w.name)}`)).values?.find((x) => x.name === w.name);
  if (existingWf) {
    const id = existingWf.id ?? existingWf.workflowId;
    if (createdId('workflow', w.name) !== id) throw new Error(`Workflow "${w.name}" exists but this setup did not create it.`);
    log('  ok      workflow (created earlier by this setup)');
    continue;
  }
  const v = await jira.post('/rest/api/3/workflows/create/validation', { payload, validationOptions: { levels: ['ERROR', 'WARNING'] } });
  for (const e of v.errors ?? []) log(`  ${e.level}: ${e.message} ${JSON.stringify(e.elementReference ?? {})}`);
  if ((v.errors ?? []).some((e) => e.level === 'ERROR')) throw new Error(`Workflow "${w.name}" failed validation; it was not created.`);
  log('  validation: passed');
  if (!APPLY) { log('  CREATE  workflow'); continue; }
  const res = await jira.post('/rest/api/3/workflows/create', payload);
  const wf = res.workflows?.[0];
  record('workflow', wf.id, w.name);
  for (const st of res.statuses ?? []) if (!siteStatuses.some((x) => String(x.id) === String(st.id))) { record('status', st.id, st.name); siteStatuses.push({ ...st, scope: { type: 'GLOBAL' } }); }
  log(`  created workflow (${wf.id})`);
}

// ── 8. Workflow scheme ─────────────────────────────────────────────────────
log('\n8. Workflow scheme');
const ws = await jira.get(`/rest/api/3/workflowscheme/${wsLink.id}`);
const mapping = ws.issueTypeMappings ?? {};
const wfToMap = [];
for (const t of TYPES) {
  const current = mapping[t.id];
  if (current === t.workflow.name) { log(`  ok      "${t.name}" → "${t.workflow.name}"`); continue; }
  if (current) throw new Error(`"${t.name}" is already mapped to "${current}" in "${ws.name}"; not replacing it.`);
  log(`  ${APPLY ? 'map   ' : 'MAP   '}  "${t.name}" → "${t.workflow.name}" (today: "${ws.defaultWorkflow}")`);
  wfToMap.push(t);
}
if (wfToMap.length) {
  // Jira asks where items in the old workflow's statuses go: a status of the
  // same name stays; otherwise the new workflow's first status of the same
  // category, else its start status.
  const oldStatuses = await statusesOf(ws.defaultWorkflow);
  const statusMappings = [];
  for (const t of wfToMap) {
    const items = (await jira.post('/rest/api/3/search/jql', { jql: `project = ${projectKey} AND issuetype = ${isPending(t.id) ? -1 : t.id}`, maxResults: 100, fields: ['status'] })).issues ?? [];
    const plan = t.workflow.statuses.map((s) => ({ ...s, id: String(siteStatuses.find((x) => lc(x.name) === lc(s.name) && x.scope?.type === 'GLOBAL')?.id ?? `<new status "${s.name}">`) }));
    for (const old of oldStatuses) {
      if (plan.some((s) => s.id === old.id)) continue;
      const to = plan.find((s) => s.statusCategory === old.statusCategory) ?? plan[0];
      statusMappings.push({ issueTypeId: t.id, statusId: old.id, newStatusId: to.id });
      const moving = items.filter((i) => String(i.fields.status.id) === old.id).map((i) => i.key);
      if (moving.length) log(`          ${moving.join(', ')}: "${old.name}" → "${to.name}"`);
    }
    const staying = items.filter((i) => plan.some((s) => s.id === String(i.fields.status.id)));
    if (staying.length) log(`          ${staying.map((i) => `${i.key} keeps "${i.fields.status.name}"`).join(', ')}`);
  }
  if (APPLY) {
    const expected = { ...mapping, ...Object.fromEntries(wfToMap.map((t) => [t.id, t.workflow.name])) };
    const draft = await jira.find(`/rest/api/3/workflowscheme/${ws.id}/draft`);
    if (draft) {
      const same = JSON.stringify(Object.entries(draft.issueTypeMappings ?? {}).sort()) === JSON.stringify(Object.entries(expected).sort()) && draft.defaultWorkflow === ws.defaultWorkflow;
      if (!same) throw new Error(`"${ws.name}" already has an unpublished draft that is not this change; publish or discard it first.`);
      log('          reusing the unpublished draft from an earlier run (same mappings)');
    } else {
      await jira.post(`/rest/api/3/workflowscheme/${ws.id}/createdraft`);
      for (const t of wfToMap) await jira.put(`/rest/api/3/workflowscheme/${ws.id}/draft/issuetype/${t.id}`, { issueType: t.id, workflow: t.workflow.name });
    }
    const done = await waitForTask(await jira.post(`/rest/api/3/workflowscheme/${ws.id}/draft/publish?validateOnly=false`, { statusMappings }));
    if (done && done.status !== 'COMPLETE') throw new Error(`Publishing the draft ended ${done.status}: ${JSON.stringify(done.result ?? done.message ?? '')}`);
    const after = (await jira.get(`/rest/api/3/workflowscheme/${ws.id}`)).issueTypeMappings ?? {};
    for (const t of wfToMap) {
      if (after[t.id] !== t.workflow.name) throw new Error(`After publishing, "${t.name}" maps to "${after[t.id] ?? ws.defaultWorkflow}", not "${t.workflow.name}".`);
      record('schemeChange', ws.id, `${projectKey}: workflowScheme`, { detail: `mapped ${t.id} (${t.name}) → ${t.workflow.name}`, undo: `remove the ${t.id} mapping from workflow scheme ${ws.id} (falls back to "${ws.defaultWorkflow}"; items need a status mapping back)` });
      log(`  mapped  "${t.name}" → "${t.workflow.name}"`);
    }
  }
}

async function statusesOf(name) {
  const res = await jira.post('/rest/api/3/workflows', { workflowNames: [name] });
  const byRef = Object.fromEntries((res.statuses ?? []).map((s) => [s.statusReference, s]));
  return res.workflows[0].statuses.map((s) => ({ id: String(byRef[s.statusReference].id), name: byRef[s.statusReference].name, statusCategory: byRef[s.statusReference].statusCategory }));
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

// ── 9. Read-back ───────────────────────────────────────────────────────────
log('\n9. Read-back');
if (!APPLY) {
  log('  skipped in a dry run');
} else {
  const ssNow = await jira.all(`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`);
  const wsNow = (await jira.get(`/rest/api/3/workflowscheme/${ws.id}`)).issueTypeMappings ?? {};
  for (const t of TYPES) {
    const ss = ssNow.find((m) => String(m.issueTypeId) === t.id)?.screenSchemeId;
    const ok = String(ss) === String(schemeId[t.key]) && wsNow[t.id] === t.workflow.name;
    log(`  ${ok ? 'ok    ' : 'WRONG '}  "${t.name}": screen scheme ${ss}, workflow "${wsNow[t.id] ?? ws.defaultWorkflow}"`);
    if (!ok) process.exitCode = 1;
  }
  const exec = TYPES.find((t) => t.key === 'execution');
  const res = await jira.post('/rest/api/3/workflows', { workflowNames: [exec.workflow.name] });
  const byRef = Object.fromEntries((res.statuses ?? []).map((s) => [s.statusReference, s]));
  for (const tr of res.workflows[0].transitions.filter((x) => x.type !== 'INITIAL' && byRef[x.toStatusReference]?.statusCategory === 'DONE')) {
    const gated = (tr.validators ?? []).some((v) => v.ruleKey === 'forge:expression-validator' && String(v.parameters?.key).endsWith('/static/va-gate'));
    log(`  ${gated ? 'ok    ' : 'NO GATE'}  Execution → Done: "${tr.name}"`);
    if (!gated) process.exitCode = 1;
  }
}

// ── 10. Link types ─────────────────────────────────────────────────────────
log('\n10. Test link types');
if (!LINK_TYPES) {
  log('  skipped (pass --link-types to create them; VAtlassian does not use them)');
} else {
  const live = (await jira.get('/rest/api/3/issueLinkType')).issueLinkTypes ?? [];
  for (const linkType of PLAN.linkTypes) {
    await ensure('linkType', linkType.name, {
      allowForeign: true,
      existing: async () => findLinkType(live, linkType.name),
      create: async () => (await jira.post('/rest/api/3/issueLinkType', linkType)).id
    });
  }
}

log(`\n${APPLY ? 'Done.' : 'Dry run complete. Nothing was changed.'} Ledger: ${stateFile}`);
log(`\nStill to do in VAtlassian administration → Test management → ${projectKey}:`);
for (const d of PLAN.issueTypes) log(`  - ${d.vatlassianRole}: ${d.name}`);
log('  - bug link type and a separate Verifies link type; keep the default sign-off chains; Save and enable');
