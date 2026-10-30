#!/usr/bin/env node
/**
 * Create the Requirements configuration defined in plan.mjs.
 *
 *   node scripts/requirements-setup/setup.mjs            # DRY RUN, read-only, prints the plan
 *   node scripts/requirements-setup/setup.mjs --apply    # creates what is missing
 *
 * Dry runs use a read-only client. Existing statuses, Acceptance Criteria,
 * the signature field and VAT permission grants are referenced without changes.
 * Attach new schemes only to the new project.
 *
 * New fields keep Jira's mandatory global context. Project/work-type contexts
 * hold scoped options; screen schemes control where fields appear.
 *
 * Record each new ID immediately in .out/state.<host>.json so later runs skip
 * it. Stop if a REQ:-prefixed object exists outside that ledger. Validate each
 * workflow through Jira before creation.
 *
 * Requires .out/inspect.json from inspect.mjs for the va-gate validator key.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from './jira.mjs';
import { PLAN } from './plan.mjs';
import { OUT, openLedger, isPending } from './state.mjs';
import { planFieldContext } from './field-context.mjs';
import { findCustomFieldsByName, findReusableCustomField } from './field-discovery.mjs';

const APPLY = process.argv.includes('--apply');
const jira = createClient({ write: APPLY });
const log = (s) => console.log(s);
const { file: stateFile, createdId, record, ensure } = openLedger(jira, { apply: APPLY, log });
const inspectFile = join(OUT, 'inspect.json');
if (!existsSync(inspectFile)) throw new Error('Run inspect.mjs first.');
const inspect = JSON.parse(readFileSync(inspectFile, 'utf8'));
if (inspect.site !== jira.site) throw new Error(`inspect.json is for ${inspect.site}, not ${jira.site}. Re-run inspect.mjs.`);

const P = PLAN.prefix;
const n = (s) => `${P}${s}`;
const lc = (s) => String(s).trim().toLowerCase();

const FIELD_TYPES = {
  select: ['com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'],
  multicheckbox: ['com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'],
  textarea: ['com.atlassian.jira.plugin.system.customfieldtypes:textarea', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'],
  text: ['com.atlassian.jira.plugin.system.customfieldtypes:textfield', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher']
};

log(`${APPLY ? 'APPLYING' : 'DRY RUN (read-only)'} on ${jira.site}\n`);

// ── 0. Facts read from the site ────────────────────────────────────────────
const me = await jira.get('/rest/api/3/myself');
const allFields = await jira.get('/rest/api/3/field');
const vaGateKey = (() => {
  for (const w of inspect.workflows ?? []) for (const t of w.transitions) for (const v of t.validators ?? []) {
    if (v.ruleKey === 'forge:expression-validator' && String(v.parameters?.key).endsWith('/static/va-gate')) return v.parameters.key;
  }
  throw new Error('No va-gate validator found on the governed project workflows in inspect.json.');
})();
log(`va-gate validator: ${vaGateKey.split('/').slice(-3).join('/')}`);

const sigCandidates = allFields.filter((f) => f.custom && lc(f.name) === lc(PLAN.signatureFieldName) && String(f.schema?.custom).includes('/static/va-approval-field'));
if (sigCandidates.length !== 1) throw new Error(`Expected exactly one VAtlassian "${PLAN.signatureFieldName}" field, found ${sigCandidates.length}.`);
const sigField = sigCandidates[0].id;
const sigContexts = await jira.all(`/rest/api/3/field/${sigField}/context`);
log(`Signature field: ${sigField} (${sigContexts.some((c) => c.isGlobalContext) ? 'global context, usable in the new project' : 'NOT global, add it to the new project manually'})`);
if (!sigContexts.some((c) => c.isGlobalContext && c.isAnyIssueType)) {
  throw new Error(`"${PLAN.signatureFieldName}" (${sigField}) has no global, all-types context. Stopping; adding the project to it would modify an existing field.`);
}

// ── 1. Work type ────────────────────────────────────────────────────────────
log('\n1. Work type');
const issueTypes = await jira.get('/rest/api/3/issuetype');
const typeId = await ensure('issueType', PLAN.issueType.name, {
  existing: async () => {
    const t = issueTypes.find((x) => lc(x.name) === lc(PLAN.issueType.name) && !x.scope);
    if (t && t.hierarchyLevel !== 0) throw new Error(`Work type "${t.name}" exists at hierarchy level ${t.hierarchyLevel}, not a standard type.`);
    return t;
  },
  create: async () => (await jira.post('/rest/api/3/issuetype', { name: PLAN.issueType.name, description: PLAN.issueType.description, hierarchyLevel: 0 })).id
});

// ── 2. Custom fields (contexts are scoped in step 9, once the project exists)
log('\n2. Custom fields');
const fieldId = {};
for (const f of PLAN.fields) {
  fieldId[f.key] = await ensure('field', f.name, {
    allowForeign: !!f.reuseIfGlobal,
    existing: async () => {
      const matches = f.reuseIfGlobal
        ? [await findReusableCustomField(jira, f.name)].filter(Boolean)
        : await findCustomFieldsByName(jira, f.name);
      if (matches.length > 1) throw new Error(`Several custom fields are named "${f.name}" (${matches.map((m) => m.id).join(', ')}).`);
      const m = matches[0];
      if (!m) return null;
      if (f.reuseIfGlobal && m.schema?.custom !== FIELD_TYPES[f.kind][0]) throw new Error(`Existing "${f.name}" is ${m.schema?.custom}, not ${f.kind}.`);
      if (f.reuseIfGlobal) {
        const ctx = await jira.all(`/rest/api/3/field/${m.id}/context`);
        if (!ctx.some((c) => c.isGlobalContext && c.isAnyIssueType)) throw new Error(`Existing "${f.name}" (${m.id}) is not global; it would need modifying to reach the new project.`);
      }
      return m;
    },
    create: async () => {
      const [type, searcherKey] = FIELD_TYPES[f.kind];
      return (await jira.post('/rest/api/3/field', { name: f.name, description: f.description, type, searcherKey })).id;
    }
  });
}
const resolveField = (token) => (token === 'sig' ? sigField : token.startsWith('f:') ? fieldId[token.slice(2)] : token);

// ── 3. Screens ──────────────────────────────────────────────────────────────
log('\n3. Screens');
const SCREEN_NAMES = { create: 'Requirement Create', edit: 'Requirement Edit', view: 'Requirement View', sign: 'Approve and sign', rework: 'Rework or reject', retire: 'Retire', revision: 'Authorize revision' };
const screenId = {};
for (const [key, label] of Object.entries(SCREEN_NAMES)) {
  const name = n(label);
  screenId[key] = await ensure('screen', name, {
    existing: async () => (await jira.all(`/rest/api/3/screens?queryString=${encodeURIComponent(name)}`)).find((s) => s.name === name),
    create: async () => (await jira.post('/rest/api/3/screens', { name, description: 'VAtlassian Requirements pilot.' })).id
  });
  const want = PLAN.screens[key].map(resolveField);
  if (isPending(screenId[key]) || want.some(isPending)) { log(`          fields: ${PLAN.screens[key].join(', ')}`); continue; }
  let tabs = await jira.get(`/rest/api/3/screens/${screenId[key]}/tabs`);
  if (!tabs.length) tabs = [await jira.post(`/rest/api/3/screens/${screenId[key]}/tabs`, { name: 'Field Tab' })];
  const tab = tabs[0].id;
  const have = new Set((await jira.get(`/rest/api/3/screens/${screenId[key]}/tabs/${tab}/fields`)).map((x) => x.id));
  for (const fid of want) {
    if (have.has(fid)) continue;
    if (!APPLY) { log(`          + add ${fid}`); continue; }
    await jira.post(`/rest/api/3/screens/${screenId[key]}/tabs/${tab}/fields`, { fieldId: fid });
  }
}

// ── 4. Screen scheme + work type screen scheme ─────────────────────────────
log('\n4. Screen schemes');
const screenSchemeName = n('Requirement Screen Scheme');
const screenSchemeId = await ensure('screenScheme', screenSchemeName, {
  existing: async () => (await jira.all(`/rest/api/3/screenscheme?queryString=${encodeURIComponent(screenSchemeName)}`)).find((s) => s.name === screenSchemeName),
  create: async () => (await jira.post('/rest/api/3/screenscheme', {
    name: screenSchemeName,
    screens: { default: Number(screenId.view), create: Number(screenId.create), edit: Number(screenId.edit), view: Number(screenId.view) }
  })).id
});
const itssName = n('Requirements Work Type Screen Scheme');
const itssId = await ensure('issueTypeScreenScheme', itssName, {
  existing: async () => (await jira.all(`/rest/api/3/issuetypescreenscheme?queryString=${encodeURIComponent(itssName)}`)).find((s) => s.name === itssName),
  create: async () => (await jira.post('/rest/api/3/issuetypescreenscheme', {
    name: itssName,
    issueTypeMappings: [{ issueTypeId: 'default', screenSchemeId: String(screenSchemeId) }, { issueTypeId: String(typeId), screenSchemeId: String(screenSchemeId) }]
  }).then((r) => r.id ?? r.issueTypeScreenSchemeId))
});

// ── 5. Field configuration + scheme ────────────────────────────────────────
log('\n5. Field configuration');
const fcName = n('Requirements Field Configuration');
const fcId = await ensure('fieldConfiguration', fcName, {
  existing: async () => (await jira.all('/rest/api/3/fieldconfiguration')).find((s) => s.name === fcName),
  create: async () => (await jira.post('/rest/api/3/fieldconfiguration', { name: fcName, description: 'VAtlassian Requirements pilot.' })).id
});
const fcItems = [
  ...PLAN.fields.filter((f) => f.requiredAlways).map((f) => ({ id: fieldId[f.key], isRequired: true })),
  ...PLAN.fields.filter((f) => f.kind === 'textarea').map((f) => ({ id: fieldId[f.key], renderer: 'atlassian-wiki-renderer' })),
  { id: 'description', isRequired: true }
];
log(`          required: ${PLAN.fields.filter((f) => f.requiredAlways).map((f) => f.name).join(', ')}, Description; rich text: ${PLAN.fields.filter((f) => f.kind === 'textarea').map((f) => f.name).join(', ')}`);
if (APPLY && !isPending(fcId)) await jira.put(`/rest/api/3/fieldconfiguration/${fcId}/fields`, { fieldConfigurationItems: fcItems });
const fcsName = n('Requirements Field Configuration Scheme');
const fcsId = await ensure('fieldConfigurationScheme', fcsName, {
  existing: async () => (await jira.all('/rest/api/3/fieldconfigurationscheme')).find((s) => s.name === fcsName),
  create: async () => {
    const s = await jira.post('/rest/api/3/fieldconfigurationscheme', { name: fcsName, description: 'VAtlassian Requirements pilot.' });
    await jira.put(`/rest/api/3/fieldconfigurationscheme/${s.id}/mapping`, { mappings: [{ issueTypeId: 'default', fieldConfigurationId: String(fcId) }] });
    return s.id;
  }
});

// ── 6. Work type scheme ─────────────────────────────────────────────────────
log('\n6. Work type scheme');
const itsName = n('Requirements Work Type Scheme');
const itsId = await ensure('issueTypeScheme', itsName, {
  existing: async () => (await jira.all('/rest/api/3/issuetypescheme')).find((s) => s.name === itsName),
  create: async () => (await jira.post('/rest/api/3/issuetypescheme', { name: itsName, issueTypeIds: [String(typeId)], defaultIssueTypeId: String(typeId) })).issueTypeSchemeId
});

// ── 7. Workflow + workflow scheme ──────────────────────────────────────────
log('\n7. Workflow');
const wfName = PLAN.requirementsWorkflowName;
const siteStatuses = await jira.all('/rest/api/3/statuses/search?');
const ref = {};
const statusPayload = PLAN.statuses.map((s) => {
  ref[s.key] = randomUUID();
  const existing = siteStatuses.find((x) => lc(x.name) === lc(s.name) && x.scope?.type === 'GLOBAL');
  if (existing && existing.statusCategory !== s.statusCategory) {
    throw new Error(`Existing status "${s.name}" is ${existing.statusCategory}, plan wants ${s.statusCategory}.`);
  }
  log(`  ${existing ? 'reuse ' : 'CREATE'}  status "${s.name}"${existing ? ` (${existing.id})` : ''}`);
  return { statusReference: ref[s.key], name: s.name, statusCategory: s.statusCategory, description: '', ...(existing ? { id: existing.id } : {}) };
});
const gate = () => ({ ruleKey: 'forge:expression-validator', parameters: { key: vaGateKey, config: JSON.stringify({ configuredIn: 'admin' }), id: randomUUID() } });
const requireFields = (ids, what) => ({
  ruleKey: 'system:validate-field-value',
  parameters: { ruleType: 'fieldRequired', fieldsRequired: ids.join(','), ignoreContext: 'true', errorMessage: `${what} must be filled in.` }
});
const beforeReview = PLAN.fields.filter((f) => f.requireBeforeReview);
const transitions = [{
  id: '1', name: 'Create', type: 'INITIAL', toStatusReference: ref.draft, links: [], actions: [], properties: {},
  validators: [{ ruleKey: 'system:check-permission-validator', parameters: { permissionKey: 'CREATE_ISSUES' } }]
}];
PLAN.transitions.forEach((t, i) => {
  const validators = [gate()];
  if (t.requireBeforeReview) validators.push(requireFields(beforeReview.map((f) => fieldId[f.key]), beforeReview.map((f) => f.name).join(', ')));
  if (t.requireFields) validators.push(requireFields(t.requireFields.map((k) => fieldId[k]), t.requireFields.map((k) => PLAN.fields.find((f) => f.key === k).name).join(', ')));
  transitions.push({
    id: String(11 + i * 10), name: t.name, type: 'DIRECTED', toStatusReference: ref[t.to],
    links: t.from.map((k) => ({ fromStatusReference: ref[k] })),
    validators, actions: [], properties: {},
    ...(t.screen ? { transitionScreen: { ruleKey: 'system:transition-screen', parameters: { screenId: String(screenId[t.screen]) } } } : {})
  });
  log(`  transition "${t.name}": ${t.from.join('/')} → ${t.to}${t.screen ? ` [screen ${t.screen}]` : ''}${t.controlled ? ` [VAtlassian-controlled: ${t.controlled.role}]` : ''}`);
});
const LAYOUT = PLAN.requirementsLayout;
const workflowPayload = {
  scope: { type: 'GLOBAL' },
  statuses: statusPayload,
  workflows: [{
    name: wfName,
    description: 'VAtlassian Requirements lifecycle. va-gate on every transition holds drifted items; signatures are configured in VAtlassian.',
    startPointLayout: { x: -150, y: 0 },
    statuses: PLAN.statuses.map((s) => ({
      statusReference: ref[s.key],
      layout: { x: LAYOUT[s.key][0], y: LAYOUT[s.key][1] },
      properties: {
        ...(s.editable ? {} : { 'jira.issue.editable': 'false' }),
        ...(s.lockAttachments ? { 'jira.permission.attachdeleteall.denied': 'true', 'jira.permission.attachdeleteown.denied': 'true' } : {})
      }
    })),
    transitions
  }]
};
const pendingIds = Object.values(screenId).some(isPending) || Object.values(fieldId).some(isPending);
let workflowCreated = false;
const existingWf = (await jira.get(`/rest/api/3/workflows/search?queryString=${encodeURIComponent(wfName)}`)).values?.find((w) => w.name === wfName);
if (existingWf) {
  if (createdId('workflow', wfName) !== existingWf.id) throw new Error(`Workflow "${wfName}" exists but this script did not create it.`);
  log(`  ok      workflow "${wfName}" (created earlier by this script)`);
  workflowCreated = true;
} else if (pendingIds) {
  writeFileSync(join(OUT, 'workflow.preview.json'), JSON.stringify(workflowPayload, null, 2));
  log(`  CREATE  workflow "${wfName}", validated after its screens/fields exist (preview: .out/workflow.preview.json)`);
} else {
  const v = await jira.post('/rest/api/3/workflows/create/validation', { payload: workflowPayload, validationOptions: { levels: ['ERROR', 'WARNING'] } });
  const errors = (v.errors ?? []).filter((e) => e.level === 'ERROR');
  for (const e of v.errors ?? []) log(`  ${e.level}: ${e.message} ${JSON.stringify(e.elementReference ?? {})}`);
  if (errors.length) throw new Error(`Workflow validation failed with ${errors.length} error(s); nothing created.`);
  log('  workflow validation: passed');
  if (APPLY) {
    const res = await jira.post('/rest/api/3/workflows/create', workflowPayload);
    const wf = res.workflows?.[0];
    record('workflow', wf.id, wfName);
    for (const st of res.statuses ?? []) {
      // Only statuses that did not exist before this call; Jira echoes reused ones too.
    if (!siteStatuses.some((x) => String(x.id) === String(st.id))) record('status', st.id, st.name);
    }
    log(`  created workflow "${wfName}" (${wf.id})`);
    workflowCreated = true;
  } else {
    log(`  CREATE  workflow "${wfName}"`);
  }
}
const wfsName = n('Requirements Workflow Scheme');
const wfsId = await ensure('workflowScheme', wfsName, {
  existing: async () => (await jira.all('/rest/api/3/workflowscheme')).find((s) => s.name === wfsName),
  create: async () => {
    if (!workflowCreated) throw new Error('Workflow not created; cannot create its scheme.');
    return (await jira.post('/rest/api/3/workflowscheme', { name: wfsName, description: 'VAtlassian Requirements pilot.', defaultWorkflow: wfName, issueTypeMappings: { [String(typeId)]: wfName } })).id;
  }
});

// ── 8. Permission scheme (copy of the governed project's grants) ───────────
log('\n8. Permission scheme');
const sourcePerm = inspect.governedProject?.permissionScheme;
if (!sourcePerm) throw new Error('No permission scheme for the governed project in inspect.json.');
const permName = n('Requirements Permission Scheme');
const permId = await ensure('permissionScheme', permName, {
  existing: async () => (await jira.get('/rest/api/3/permissionscheme')).permissionSchemes.find((s) => s.name === permName),
  create: async () => {
    const src = await jira.get(`/rest/api/3/permissionscheme/${sourcePerm.id}?expand=permissions`);
    const permissions = src.permissions.map((g) => ({ permission: g.permission, holder: { type: g.holder.type, ...(g.holder.parameter != null ? { parameter: g.holder.parameter } : {}), ...(g.holder.value != null ? { value: g.holder.value } : {}) } }));
    return (await jira.post('/rest/api/3/permissionscheme', { name: permName, description: `Copy of "${src.name}" grants for the Requirements pilot.`, permissions })).id;
  }
});
log(`          grants copied from "${sourcePerm.name}" (${sourcePerm.id}); Baselined/Released/In Review/Rejected/Obsolete are non-editable by workflow property`);

// ── 9. Project ──────────────────────────────────────────────────────────────
log('\n9. Project');
const projectId = await ensure('project', PLAN.project.key, {
  existing: async () => jira.find(`/rest/api/3/project/${PLAN.project.key}`),
  create: async () => (await jira.post('/rest/api/3/project', {
    key: PLAN.project.key, name: PLAN.project.name, description: PLAN.project.description,
    leadAccountId: me.accountId, projectTypeKey: 'software', assigneeType: 'UNASSIGNED',
    issueTypeScheme: Number(itsId), issueTypeScreenScheme: Number(itssId), fieldConfigurationScheme: Number(fcsId),
    workflowScheme: Number(wfsId), permissionScheme: Number(permId)
  })).id
});

// ── 10. Scope the new fields to the project + work type ────────────────────
log('\n10. Field contexts');
const ctxName = n(PLAN.project.name);
for (const f of PLAN.fields) {
  const fid = fieldId[f.key];
  if (!createdId('field', f.name)) { if (!isPending(fid)) log(`  skip    "${f.name}" (existing field, left as is)`); else log(`  SCOPE   "${f.name}" → ${PLAN.project.key} / ${PLAN.issueType.name}${f.options ? `; options: ${f.options.join(', ')}` : ''}`); continue; }
  if (isPending(projectId) || isPending(typeId)) { log(`  SCOPE   "${f.name}" → ${PLAN.project.key} / ${PLAN.issueType.name}`); continue; }
  const contexts = await jira.all(`/rest/api/3/field/${fid}/context`);
  const contextPlan = planFieldContext({ contexts, scopedName: ctxName });
  let ours = contextPlan.scopedContext;
  if (contextPlan.createScopedContext) {
    if (!APPLY) { log(`  SCOPE   "${f.name}" → ${PLAN.project.key} / ${PLAN.issueType.name}`); continue; }
    ours = await jira.post(`/rest/api/3/field/${fid}/context`, { name: ctxName, description: 'VAtlassian Requirements pilot.', projectIds: [String(projectId)], issueTypeIds: [String(typeId)] });
    log(`  scoped  "${f.name}" → context ${ours.id}`);
  }
  if (f.options) {
    const have = new Set((await jira.all(`/rest/api/3/field/${fid}/context/${ours.id}/option`)).map((o) => o.value));
    const missing = f.options.filter((o) => !have.has(o));
    if (missing.length && APPLY) await jira.post(`/rest/api/3/field/${fid}/context/${ours.id}/option`, { options: missing.map((value) => ({ value, disabled: false })) });
    if (missing.length) log(`  ${APPLY ? 'added' : 'ADD'}   options for "${f.name}": ${missing.join(', ')}`);
  }
}

// ── 11. Link types (site-wide) ─────────────────────────────────────────────
log('\n11. Link types (site-wide)');
const linkTypes = (await jira.get('/rest/api/3/issueLinkType')).issueLinkTypes;
for (const l of PLAN.linkTypes) {
  await ensure('linkType', l.name, {
    allowForeign: true,
    existing: async () => linkTypes.find((x) => lc(x.name) === lc(l.name)),
    create: async () => (await jira.post('/rest/api/3/issueLinkType', l)).id
  });
}

log(`\n${APPLY ? 'Done.' : 'Dry run complete. Nothing was changed.'} State: ${stateFile}`);
log('\nStill to do in VAtlassian administration (not Jira):');
for (const t of PLAN.transitions.filter((x) => x.controlled)) {
  log(`  - Controlled transition "${t.name}" (${t.from.join('/')} → ${t.to}) for ${PLAN.project.key}/${PLAN.issueType.name}: role ${t.controlled.role}${t.controlled.captureBaseline ? ', capture baseline' : ''}`);
}
log(`  - Controlled fields for ${PLAN.project.key}/${PLAN.issueType.name}`);
log('  - Grant REVIEWER / APPROVER roles to the pilot users');
