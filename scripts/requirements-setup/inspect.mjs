#!/usr/bin/env node
/**
 * READ-ONLY inspection of the target Jira site before any Requirements setup.
 *
 * Uses a read-only client: it cannot create, change or delete anything. It
 * writes what it found to scripts/requirements-setup/.out/inspect.json (the
 * .out folder is gitignored) and prints a short summary.
 *
 *   node scripts/requirements-setup/inspect.mjs [--cm-issue VAT-78] [--governed-project VAT] [--key REQ]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './jira.mjs';
import { PLAN } from './plan.mjs';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map((s) => {
  const [k, ...v] = s.trim().split(/\s+/);
  return [k, v.join(' ') || true];
}));
const cmIssueKey = args['cm-issue'] ?? 'VAT-78';
const governedProjectKey = args['governed-project'] ?? 'VAT';
const projectKey = args.key ?? PLAN.project.key;

const jira = createClient({ write: false });
const report = { site: jira.site, inspectedAt: new Date().toISOString(), problems: [] };
const problem = (msg) => { report.problems.push(msg); };

async function step(name, fn) {
  try { report[name] = await fn(); } catch (e) { report[name] = { error: e.message }; problem(`${name}: ${e.message}`); }
}

await step('me', async () => {
  const me = await jira.get('/rest/api/3/myself');
  const perms = await jira.get('/rest/api/3/mypermissions?permissions=ADMINISTER');
  return { accountId: me.accountId, displayName: me.displayName, isJiraAdmin: !!perms.permissions?.ADMINISTER?.havePermission };
});
if (report.me?.isJiraAdmin === false) problem('The credential is not a Jira administrator. Setup requires Administer Jira.');

await step('changeItem', async () => {
  const i = await jira.get(`/rest/api/3/issue/${encodeURIComponent(cmIssueKey)}?fields=issuetype,status,project,summary`);
  return {
    key: i.key, summary: i.fields.summary,
    issueType: { id: i.fields.issuetype.id, name: i.fields.issuetype.name },
    status: { id: i.fields.status.id, name: i.fields.status.name, category: i.fields.status.statusCategory?.key },
    project: { id: i.fields.project.id, key: i.fields.project.key }
  };
});

await step('governedProject', async () => {
  const p = await jira.get(`/rest/api/3/project/${governedProjectKey}?expand=issueTypes`);
  const wfs = await jira.get(`/rest/api/3/workflowscheme/project?projectId=${p.id}`);
  const scheme = wfs.values?.[0]?.workflowScheme ?? null;
  const perm = await jira.find(`/rest/api/3/project/${p.id}/permissionscheme`);
  return {
    id: p.id, key: p.key, name: p.name, style: p.style,
    issueTypes: p.issueTypes.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask })),
    workflowScheme: scheme && { id: scheme.id, name: scheme.name, defaultWorkflow: scheme.defaultWorkflow, issueTypeMappings: scheme.issueTypeMappings },
    permissionScheme: perm && { id: perm.id, name: perm.name }
  };
});

await step('workflows', async () => {
  const s = report.governedProject?.workflowScheme;
  if (!s) return [];
  const names = [...new Set([s.defaultWorkflow, ...Object.values(s.issueTypeMappings ?? {})].filter(Boolean))];
  const res = await jira.post('/rest/api/3/workflows', { workflowNames: names });
  const statusName = Object.fromEntries((res.statuses ?? []).map((st) => [st.statusReference, `${st.name} (${st.id ?? st.statusReference})`]));
  return (res.workflows ?? []).map((w) => ({
    id: w.id, name: w.name,
    statuses: w.statuses.map((st) => ({ status: statusName[st.statusReference] ?? st.statusReference, properties: st.properties })),
    transitions: w.transitions.map((t) => ({
      id: t.id, name: t.name, type: t.type,
      from: (t.links ?? []).map((l) => statusName[l.fromStatusReference] ?? l.fromStatusReference),
      to: statusName[t.toStatusReference] ?? t.toStatusReference,
      screen: t.transitionScreen ?? null,
      validators: t.validators, conditions: t.conditions, actions: t.actions, properties: t.properties
    }))
  }));
});

await step('transitionScreens', async () => {
  const ids = new Set();
  for (const w of Array.isArray(report.workflows) ? report.workflows : []) {
    for (const t of w.transitions) {
      const p = t.screen?.parameters ?? {};
      const id = p.screenId ?? t.screen?.id;
      if (id) ids.add(String(id));
    }
  }
  const out = [];
  for (const id of ids) {
    const tabs = await jira.get(`/rest/api/3/screens/${id}/tabs`);
    const fields = [];
    for (const tab of tabs) fields.push(...(await jira.get(`/rest/api/3/screens/${id}/tabs/${tab.id}/fields`)).map((f) => ({ id: f.id, name: f.name })));
    out.push({ id, fields });
  }
  return out;
});

await step('issueTypes', async () => {
  const all = await jira.get('/rest/api/3/issuetype');
  return all.map((t) => ({ id: t.id, name: t.name, hierarchyLevel: t.hierarchyLevel, scoped: !!t.scope }));
});

await step('statuses', async () => {
  const wanted = new Set(PLAN.statuses.map((s) => s.name.toLowerCase()));
  const all = await jira.all('/rest/api/3/statuses/search?');
  return all
    .filter((s) => wanted.has(s.name.toLowerCase()))
    .map((s) => ({ id: s.id, name: s.name, category: s.statusCategory, scope: s.scope?.type, projectId: s.scope?.project?.id ?? null }));
});

await step('fields', async () => {
  const all = await jira.get('/rest/api/3/field');
  const wanted = new Set(PLAN.fields.map((f) => f.name.toLowerCase()));
  const interesting = /signature|biometric|approval|requirement|rationale|verification|acceptance|source|classification/i;
  return all
    .filter((f) => f.custom && (wanted.has(f.name.toLowerCase()) || interesting.test(f.name)))
    .map((f) => ({ id: f.id, name: f.name, type: f.schema?.custom, plannedName: wanted.has(f.name.toLowerCase()) }));
});

await step('linkTypes', async () => {
  const r = await jira.get('/rest/api/3/issueLinkType');
  return r.issueLinkTypes.map((t) => ({ id: t.id, name: t.name, outward: t.outward, inward: t.inward }));
});

await step('projectRoles', async () => (await jira.get('/rest/api/3/role')).map((r) => ({ id: r.id, name: r.name })));

await step('projectKey', async () => {
  const existing = await jira.find(`/rest/api/3/project/${projectKey}`);
  const v = await jira.get(`/rest/api/3/projectvalidate/key?key=${encodeURIComponent(projectKey)}`);
  return { key: projectKey, existingProject: existing && { id: existing.id, name: existing.name }, validation: v };
});

await step('nameCollisions', async () => {
  const p = PLAN.prefix;
  const [screens, screenSchemes, itss, fcs, fcss, perms, its] = await Promise.all([
    jira.all(`/rest/api/3/screens?queryString=${encodeURIComponent(p)}`),
    jira.all(`/rest/api/3/screenscheme?queryString=${encodeURIComponent(p)}`),
    jira.all(`/rest/api/3/issuetypescreenscheme?queryString=${encodeURIComponent(p)}`),
    jira.all('/rest/api/3/fieldconfiguration'),
    jira.all('/rest/api/3/fieldconfigurationscheme'),
    jira.get('/rest/api/3/permissionscheme'),
    jira.all('/rest/api/3/issuetypescheme')
  ]);
  const mine = (n) => n?.startsWith(p);
  return {
    screens: screens.filter((x) => mine(x.name)).map((x) => x.name),
    screenSchemes: screenSchemes.filter((x) => mine(x.name)).map((x) => x.name),
    issueTypeScreenSchemes: itss.filter((x) => mine(x.name)).map((x) => x.name),
    fieldConfigurations: fcs.filter((x) => mine(x.name)).map((x) => x.name),
    fieldConfigurationSchemes: fcss.filter((x) => mine(x.name)).map((x) => x.name),
    permissionSchemes: perms.permissionSchemes.filter((x) => mine(x.name)).map((x) => x.name),
    issueTypeSchemes: its.filter((x) => mine(x.name)).map((x) => x.name)
  };
});

const outDir = join(dirname(fileURLToPath(import.meta.url)), '.out');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'inspect.json');
writeFileSync(outFile, JSON.stringify(report, null, 2));

const ci = report.changeItem;
console.log(`Site:            ${report.site}`);
console.log(`Credential:      ${report.me?.displayName ?? '?'} (Jira admin: ${report.me?.isJiraAdmin ?? '?'})`);
console.log(`Change item:     ${ci?.key ?? '?'}, type "${ci?.issueType?.name ?? '?'}" (${ci?.issueType?.id ?? '?'}), status "${ci?.status?.name ?? '?'}"`);
console.log(`Project key ${projectKey}: ${report.projectKey?.existingProject ? 'TAKEN by ' + report.projectKey.existingProject.name : 'free'}`);
console.log(`"Requirement" type exists: ${(report.issueTypes ?? []).some?.((t) => t.name.toLowerCase() === 'requirement') ?? '?'}`);
console.log(`Planned field names already in use: ${(report.fields ?? []).filter?.((f) => f.plannedName).map((f) => f.name).join(', ') || 'none'}`);
console.log(`Problems: ${report.problems.length ? '\n  - ' + report.problems.join('\n  - ') : 'none'}`);
console.log(`Full report: ${outFile}`);
