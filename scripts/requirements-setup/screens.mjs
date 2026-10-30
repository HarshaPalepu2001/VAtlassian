#!/usr/bin/env node
/**
 * Add project-scoped fields and screens after attach-project.mjs.
 *
 * Scope each custom field to this project and its one work type. Create fields
 * for Requirements and Source Document, their create,
 * edit and view screens, and Requirements rework, retire and revision screens.
 * Map each screen scheme in the project's work-type screen scheme and add
 * transition screens and filled-in validators to both workflows.
 *
 *   node scripts/requirements-setup/screens.mjs --project VAT            # DRY RUN
 *   node scripts/requirements-setup/screens.mjs --project VAT --apply
 *
 * Stop for shared work-type screen schemes or conflicting existing mappings.
 * Stop for planned-name fields, screens or schemes not created by this setup,
 * except the intentionally reused Acceptance Criteria field. Update only the
 * two setup-owned workflows after Jira validation. Keep the signature field
 * on signed transitions and record each change with its reversal instructions.
 *
 * Use workflow validators for required fields because the project may share
 * the site's default field configuration.
 */
import { createClient } from './jira.mjs';
import { PLAN } from './plan.mjs';
import { openLedger, isPending } from './state.mjs';
import { planFieldContext } from './field-context.mjs';
import { findCustomFieldsByName, findReusableCustomField } from './field-discovery.mjs';
import { fieldAssociationPayload, missingFieldAssociations } from './field-association.mjs';

const APPLY = process.argv.includes('--apply');
const projectKey = process.argv[process.argv.indexOf('--project') + 1];
if (!process.argv.includes('--project') || !projectKey || projectKey.startsWith('--')) throw new Error('Usage: screens.mjs --project <KEY> [--apply]');
const jira = createClient({ write: APPLY });
const log = (s) => console.log(s);
const { file: stateFile, createdId, record, ensure } = openLedger(jira, { apply: APPLY, log });
const lc = (s) => String(s).trim().toLowerCase();

const FIELD_TYPES = {
  select: ['com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'],
  multicheckbox: ['com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'],
  textarea: ['com.atlassian.jira.plugin.system.customfieldtypes:textarea', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'],
  text: ['com.atlassian.jira.plugin.system.customfieldtypes:textfield', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'],
  date: ['com.atlassian.jira.plugin.system.customfieldtypes:datepicker', 'com.atlassian.jira.plugin.system.customfieldtypes:daterange']
};

log(`${APPLY ? 'APPLYING' : 'DRY RUN (read-only)'} on ${jira.site}, project ${projectKey}\n`);

// ── Preflight ──────────────────────────────────────────────────────────────
const project = await jira.get(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
if (project.style !== 'classic') throw new Error(`${projectKey} is team-managed; global work types and screens cannot be used there.`);

const TYPES = [
  { key: 'requirements', name: PLAN.issueType.name, workflow: PLAN.requirementsWorkflowName, fields: PLAN.fields, screens: PLAN.screens, transitions: PLAN.transitions, names: PLAN.screenNames.requirements },
  { key: 'sourceDocument', name: PLAN.sourceDocument.issueType.name, workflow: PLAN.sourceDocument.workflowName, fields: PLAN.sourceDocument.fields, screens: PLAN.sourceDocument.screens, transitions: PLAN.sourceDocument.transitions, names: PLAN.screenNames.sourceDocument }
].map((t) => {
  const id = createdId('issueType', t.name);
  const workflowId = createdId('workflow', t.workflow);
  if (!id || !workflowId) throw new Error(`"${t.name}" or its workflow is not in the ledger. Run work-types.mjs --apply first.`);
  return { ...t, id, workflowId };
});

const projectTypes = (await jira.get(`/rest/api/3/project/${project.id}?expand=issueTypes`)).issueTypes.map((t) => String(t.id));
for (const t of TYPES) if (!projectTypes.includes(t.id)) throw new Error(`"${t.name}" is not in ${projectKey} yet. Run attach-project.mjs --project ${projectKey} --apply first.`);

const allFields = await jira.get('/rest/api/3/field');
const sigCandidates = allFields.filter((f) => f.custom && lc(f.name) === lc(PLAN.signatureFieldName) && String(f.schema?.custom).includes('/static/va-approval-field'));
if (sigCandidates.length !== 1) throw new Error(`Expected exactly one VAtlassian "${PLAN.signatureFieldName}" field, found ${sigCandidates.length}.`);
const sigField = sigCandidates[0].id;
const sigScreen = createdId('screen', PLAN.signatureScreenName);
if (!sigScreen) throw new Error(`"${PLAN.signatureScreenName}" is not in the ledger. Run work-types.mjs --apply first.`);

const classicIds = (await jira.all('/rest/api/3/project/search')).filter((p) => p.style === 'classic').map((p) => p.id);
const itssLink = (await jira.get(`/rest/api/3/issuetypescreenscheme/project?projectId=${project.id}`)).values?.[0];
if (!itssLink) throw new Error(`No work type screen scheme found for ${projectKey}.`);
const itss = itssLink.issueTypeScreenScheme;
const itssUsers = [];
for (let i = 0; i < classicIds.length; i += 50) {
  const q = classicIds.slice(i, i + 50).map((id) => `projectId=${id}`).join('&');
  for (const r of await jira.all(`/rest/api/3/issuetypescreenscheme/project?${q}`)) if (String(r.issueTypeScreenScheme.id) === String(itss.id)) itssUsers.push(...r.projectIds);
}
if (new Set(itssUsers.map(String)).size !== 1) throw new Error(`Work type screen scheme "${itss.name}" is shared by several projects; not changing it.`);
const itssMappings = await jira.all(`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`);

// ── 1. Custom fields ───────────────────────────────────────────────────────
log('1. Custom fields');
const fieldId = {};
for (const t of TYPES) {
  for (const f of t.fields) {
    const id = await ensure('field', f.name, {
      allowForeign: !!f.reuseIfGlobal,
      existing: async () => {
        const matches = f.reuseIfGlobal
          ? [await findReusableCustomField(jira, f.name)].filter(Boolean)
          : await findCustomFieldsByName(jira, f.name);
        if (matches.length > 1) throw new Error(`Several custom fields are named "${f.name}" (${matches.map((m) => m.id).join(', ')}).`);
        const m = matches[0];
        if (!m) return null;
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
    fieldId[`${t.key}:${f.key}`] = id;
    await scopeField(f, id, t);
  }
}

// Jira no longer allows deleting the default global context (CHANGE-3019).
// Keep it, add a project/work-type variant for options, and use the work type
// screen scheme below to decide where the field is actually displayed.
async function scopeField(f, fid, t) {
  if (!createdId('field', f.name)) return; // reused, left as is
  const ctxName = `${projectKey}: ${t.name}`;
  if (isPending(fid)) { log(`          SCOPE   → ${ctxName}${f.options ? `; options: ${f.options.join(', ')}` : ''}`); return; }
  const contexts = await jira.all(`/rest/api/3/field/${fid}/context`);
  const contextPlan = planFieldContext({ contexts, scopedName: ctxName });
  let ours = contextPlan.scopedContext;
  if (contextPlan.createScopedContext) {
    if (!APPLY) { log(`          SCOPE   → ${ctxName}`); return; }
    ours = await jira.post(`/rest/api/3/field/${fid}/context`, { name: ctxName, description: 'VAtlassian.', projectIds: [String(project.id)], issueTypeIds: [t.id] });
    log(`          scoped  → context ${ours.id} (${ctxName})`);
  }
  if (f.options) {
    const have = new Set((await jira.all(`/rest/api/3/field/${fid}/context/${ours.id}/option`)).map((o) => o.value));
    const missing = f.options.filter((o) => !have.has(o));
    if (missing.length && APPLY) await jira.post(`/rest/api/3/field/${fid}/context/${ours.id}/option`, { options: missing.map((value) => ({ value, disabled: false })) });
    if (missing.length) log(`          ${APPLY ? 'added' : 'ADD'}   options: ${missing.join(', ')}`);
  }
}

// ── 2. Screens ─────────────────────────────────────────────────────────────
log('\n2. Screens');
const screenId = {};
for (const t of TYPES) {
  const resolve = (token) => (token === 'sig' ? sigField : token.startsWith('f:') ? fieldId[`${t.key}:${token.slice(2)}`] : token);
  for (const [key, fields] of Object.entries(t.screens)) {
    if (key === 'sign') continue; // the shared signature screen (work-types.mjs)
    const name = t.names[key];
    screenId[`${t.key}:${key}`] = await ensure('screen', name, {
      existing: async () => (await jira.all(`/rest/api/3/screens?queryString=${encodeURIComponent(name)}`)).find((s) => s.name === name),
      create: async () => (await jira.post('/rest/api/3/screens', { name, description: `VAtlassian ${t.name}.` })).id
    });
    await fillScreen(screenId[`${t.key}:${key}`], fields, resolve);
  }
}

// Adds missing fields to the first tab, in plan order. Never removes one.
async function fillScreen(sid, tokens, resolve) {
  const want = tokens.map(resolve);
  if (isPending(sid) || want.some(isPending)) { log(`          fields: ${tokens.join(', ')}`); return; }
  let tabs = await jira.get(`/rest/api/3/screens/${sid}/tabs`);
  if (!tabs.length && APPLY) tabs = [await jira.post(`/rest/api/3/screens/${sid}/tabs`, { name: 'Field Tab' })];
  const have = tabs.length ? new Set((await jira.get(`/rest/api/3/screens/${sid}/tabs/${tabs[0].id}/fields`)).map((x) => x.id)) : new Set();
  const missing = want.filter((fid) => !have.has(fid));
  for (const fid of missing) if (APPLY) await jira.post(`/rest/api/3/screens/${sid}/tabs/${tabs[0].id}/fields`, { fieldId: fid });
  log(missing.length ? `          ${APPLY ? 'added' : 'ADD'}   ${missing.join(', ')}` : '          fields ok');
}

// ── 3. Screen schemes, mapped in the project's work type screen scheme ─────
log('\n3. Screen schemes');
const schemeId = {};
for (const t of TYPES) {
  const name = t.names.scheme;
  const s = (k) => Number(screenId[`${t.key}:${k}`]);
  schemeId[t.key] = await ensure('screenScheme', name, {
    existing: async () => (await jira.all(`/rest/api/3/screenscheme?queryString=${encodeURIComponent(name)}`)).find((x) => x.name === name),
    create: async () => (await jira.post('/rest/api/3/screenscheme', { name, description: `VAtlassian ${t.name}.`, screens: { default: s('view'), create: s('create'), edit: s('edit'), view: s('view') } })).id
  });
}
log(`\n   Work type screen scheme "${itss.name}" (${itss.id})`);
const toMap = [];
for (const t of TYPES) {
  const current = itssMappings.find((m) => String(m.issueTypeId) === t.id);
  if (current && String(current.screenSchemeId) === String(schemeId[t.key])) { log(`  ok      "${t.name}" → "${t.names.scheme}"`); continue; }
  if (current) throw new Error(`"${t.name}" is already mapped to screen scheme ${current.screenSchemeId} in "${itss.name}"; not replacing it.`);
  log(`  ${APPLY ? 'map   ' : 'MAP   '}  "${t.name}" → "${t.names.scheme}" (default today: ${itssMappings.find((m) => m.issueTypeId === 'default')?.screenSchemeId})`);
  toMap.push(t);
}
if (toMap.length && APPLY) {
  await jira.put(`/rest/api/3/issuetypescreenscheme/${itss.id}/mapping`, { issueTypeMappings: toMap.map((t) => ({ issueTypeId: t.id, screenSchemeId: String(schemeId[t.key]) })) });
  for (const t of toMap) record('schemeChange', itss.id, `${projectKey}: issueTypeScreenScheme`, { detail: `mapped ${t.id} (${t.name}) → screen scheme ${schemeId[t.key]}`, undo: `remove the ${t.id} mapping from work type screen scheme ${itss.id} (falls back to its default)` });
}

// ── 4. Jira field associations ────────────────────────────────────────
// Jira's field-association layer is separate from contexts and screens. The
// project-filtered field catalogue is the association oracle; create metadata
// is too narrow because it omits fields used only on transition/view screens.
// Only fields created by this setup are associated; the reused Acceptance
// Criteria field is left alone.
log('\n4. Jira field associations');
async function associationGaps() {
  const expected = TYPES.flatMap((t) => t.fields
    .filter((f) => createdId('field', f.name))
    .map((f) => fieldId[`${t.key}:${f.key}`]))
    .filter((id) => !isPending(id));
  const associated = await jira.all(`/rest/api/3/field/search?projectIds=${project.id}`);
  return missingFieldAssociations(expected, { values: associated });
}

let unassociated = await associationGaps();
if (!unassociated.length) {
  log('  ok      created fields are associated with the project');
  if (APPLY && !createdId('fieldAssociation', projectKey)) {
    record('fieldAssociation', project.id, projectKey, {
      detail: `verified all setup-created fields are associated with project ${projectKey}`,
      undo: 'no change was made by this recovery record'
    });
  }
} else if (!APPLY) {
  log(`  ASSOCIATE ${unassociated.join(', ')} with ${projectKey}`);
} else {
  const associated = [...unassociated];
  await jira.put('/rest/api/3/field/association', fieldAssociationPayload(project.id, unassociated));
  for (let attempt = 0; attempt < 5 && unassociated.length; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
    unassociated = await associationGaps();
  }
  if (unassociated.length) throw new Error(`Jira still omits associated fields from create metadata: ${unassociated.join(', ')}.`);
  record('fieldAssociation', project.id, projectKey, {
    detail: `associated ${associated.length} setup-created fields with project ${projectKey}: ${associated.join(', ')}`,
    undo: `remove only the setup-created field associations from project ${projectKey}`
  });
  log(`  associated ${associated.length} fields with ${projectKey}; create metadata verified`);
}

// ── 5. Workflows: transition screens and "filled in" validators ──────────────
// A dry run validates against stand-ins for objects that do not exist yet:
// Description for a new field, the signature screen for a new screen.
const real = (id, standIn) => (isPending(id) ? standIn : id);
const requireFields = (ids, what) => ({
  ruleKey: 'system:validate-field-value',
  parameters: { ruleType: 'fieldRequired', fieldsRequired: ids.join(','), ignoreContext: 'true', errorMessage: `${what} must be filled in.` }
});
// The project may share the site's default field configuration, so the
// always-required Requirements fields are required before review instead.
const beforeReview = PLAN.fields.filter((f) => f.requireBeforeReview || f.requiredAlways);

for (const t of TYPES) {
  log(`\n5. Workflow "${t.workflow}"`);
  const fieldsOf = (keys) => keys.map((k) => real(fieldId[`${t.key}:${k}`], 'description'));
  const namesOf = (keys) => keys.map((k) => t.fields.find((f) => f.key === k).name).join(', ');
  const res = await jira.post('/rest/api/3/workflows', { workflowIds: [t.workflowId] });
  const wf = res.workflows?.[0];
  if (!wf) throw new Error(`Workflow ${t.workflowId} not found.`);
  let changes = 0;
  const transitions = wf.transitions.map((tr) => {
    const p = t.transitions.find((x) => x.name === tr.name);
    if (!p) return tr;
    const next = { ...tr, validators: [...(tr.validators ?? [])] };
    const planned = p.screen && p.screen !== 'sign' ? screenId[`${t.key}:${p.screen}`] : p.controlled ? sigScreen : null;
    const haveScreen = tr.transitionScreen?.parameters?.screenId ?? null;
    if (planned && (isPending(planned) || String(haveScreen) !== String(planned))) {
      const wantScreen = real(planned, sigScreen);
      if (p.controlled && p.screen && p.screen !== 'sign' && !t.screens[p.screen].includes('sig')) throw new Error(`"${tr.name}" is signed but screen "${p.screen}" has no signature field.`);
      next.transitionScreen = { ruleKey: 'system:transition-screen', parameters: { screenId: String(wantScreen) } };
      log(`  ${APPLY ? 'screen' : 'SCREEN'}  "${tr.name}" → ${t.names[p.screen] ?? PLAN.signatureScreenName}`);
      changes++;
    }
    const wanted = [];
    if (p.requireBeforeReview) wanted.push(requireFields(beforeReview.map((f) => real(fieldId[`requirements:${f.key}`], 'description')), beforeReview.map((f) => f.name).join(', ')));
    if (p.requireFields) wanted.push(requireFields(fieldsOf(p.requireFields), namesOf(p.requireFields)));
    // "Filled in" validators on these transitions are ours: drop any that are
    // not wanted any more (an older field list), add the missing ones.
    const same = (x, v) => x.ruleKey === v.ruleKey && x.parameters?.fieldsRequired === v.parameters.fieldsRequired;
    const isFilledIn = (x) => x.ruleKey === 'system:validate-field-value' && x.parameters?.ruleType === 'fieldRequired';
    const stale = next.validators.filter((x) => isFilledIn(x) && !wanted.some((v) => same(x, v)));
    next.validators = next.validators.filter((x) => !stale.includes(x));
    changes += stale.length;
    for (const v of wanted) {
      if (next.validators.some((x) => same(x, v))) continue;
      next.validators.push(v);
      log(`  ${APPLY ? 'require' : 'REQUIRE'} "${tr.name}": ${v.parameters.errorMessage.replace(/ must be filled in\.$/, '')}`);
      changes++;
    }
    return next;
  });
  if (!changes) { log('  ok      transition screens and validators'); continue; }
  const update = {
    statuses: res.statuses,
    workflows: [{ id: wf.id, version: wf.version, description: wf.description, startPointLayout: wf.startPointLayout, statuses: wf.statuses, transitions, ...(wf.loopedTransitionContainerLayout ? { loopedTransitionContainerLayout: wf.loopedTransitionContainerLayout } : {}) }]
  };
  const v = await jira.post('/rest/api/3/workflows/update/validation', { payload: update, validationOptions: { levels: ['ERROR', 'WARNING'] } });
  for (const e of v.errors ?? []) log(`  ${e.level}: ${e.message} ${JSON.stringify(e.elementReference ?? {})}`);
  if ((v.errors ?? []).some((e) => e.level === 'ERROR')) throw new Error(`Workflow "${t.workflow}" update failed validation; it was not changed.`);
  log(`  validation: passed${Object.values(fieldId).some(isPending) || Object.values(screenId).some(isPending) ? ' (new fields and screens checked against stand-ins)' : ''}`);
  if (!APPLY) continue;
  await jira.post('/rest/api/3/workflows/update', update);
  record('workflowChange', wf.id, t.workflow, { detail: `transition screens and required-field validators (from version ${wf.version.versionNumber})`, undo: `restore version ${wf.version.versionNumber} of the workflow from its history` });
  log(`  updated workflow (${wf.id})`);
}

log(`\n${APPLY ? 'Done.' : 'Dry run complete. Nothing was changed.'} Ledger: ${stateFile}`);
log(`\nNot done here:`);
log(`  - Link types (Derives, Satisfies, …). Run link-types.mjs.`);
log(`  - VAtlassian controlled transitions and controlled fields for ${projectKey} (see attach-project.mjs output).`);
