import { contentDigest, MAX_STEPS, MAX_TEXT } from './content.js';

export const MAX_PARAMETERS = 20;
export const MAX_ITERATIONS = 100;
export const MAX_EXPANDED_STEPS = 1000;
export const MAX_EXPANDED_TEXT = 250000;
export const MAX_COLLECTION_MEMBERS = 200;
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const reserved = new Set(['constructor', 'prototype', '__proto__']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.replace(/\r\n/g, '\n') : null;
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };

/** Dataset bytes belong to the immutable test version. Rows have explicit, stable iteration ids. */
export function normaliseDataset(input) {
  if (input == null) return { dataset: null };
  if (!object(input)) return { error: 'DATASET_INVALID' };
  const mode = input.mode ?? 'ROWS';
  if (!['ROWS', 'COMBINATORIAL'].includes(mode)) return { error: 'DATASET_INVALID' };
  if (!Array.isArray(input.parameters) || !input.parameters.length || input.parameters.length > MAX_PARAMETERS) return { error: 'PARAMETER_INVALID' };
  const names = new Set(); const parameters = [];
  let bytes = 0;
  for (const p of input.parameters) {
    if (!NAME.test(p?.name ?? '') || reserved.has(p.name) || names.has(p.name) || !['TEXT', 'LIST'].includes(p.type)) return { error: 'PARAMETER_INVALID' };
    names.add(p.name);
    const out = { name: p.name, type: p.type };
    if (p.type === 'LIST') {
      if (!Array.isArray(p.values) || !p.values.length || p.values.length > MAX_ITERATIONS) return { error: 'PARAMETER_VALUES_INVALID' };
      out.values = p.values.map(text);
      if (out.values.some(v => v == null || v.length > MAX_TEXT) || new Set(out.values).size !== out.values.length) return { error: 'PARAMETER_VALUES_INVALID' };
      bytes += out.values.reduce((sum, v) => sum + v.length, 0);
    } else if (p.value != null) {
      out.value = text(p.value);
      if (out.value == null || out.value.length > MAX_TEXT) return { error: 'PARAMETER_VALUES_INVALID' };
      bytes += out.value.length;
    }
    parameters.push(out);
  }
  const rows = [];
  if (mode === 'COMBINATORIAL') {
    if (input.rows != null && (!Array.isArray(input.rows) || input.rows.length)) return { error: 'DATASET_INVALID' };
    let count = 1;
    for (const p of parameters) {
      if (p.type === 'TEXT' && p.value == null) return { error: 'PARAMETER_VALUES_INVALID' };
      count *= p.type === 'LIST' ? p.values.length : 1;
      if (count > MAX_ITERATIONS) return { error: 'TOO_MANY_ITERATIONS' };
    }
  } else {
    if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > MAX_ITERATIONS) return { error: 'TOO_MANY_ITERATIONS' };
    const ids = new Set();
    for (const row of input.rows) {
      if (!ID.test(row?.id ?? '') || row.id.includes('__') || ids.has(row.id)) return { error: 'ITERATION_ID_INVALID' };
      ids.add(row.id);
      if (!object(row.values) || Object.keys(row.values).length !== parameters.length || Object.keys(row.values).some(n => !names.has(n))) return { error: 'ROW_VALUES_INVALID' };
      const values = {};
      for (const p of parameters) {
        const value = text(row.values[p.name]);
        if (value == null || value.length > MAX_TEXT || (p.type === 'LIST' && !p.values.includes(value))) return { error: 'ROW_VALUES_INVALID' };
        values[p.name] = value; bytes += value.length;
      }
      rows.push({ id: row.id, values });
    }
  }
  if (bytes > 128000) return { error: 'DATASET_TOO_LARGE' };
  return { dataset: frozen({ schema: 1, mode, parameters, rows }) };
}

/** Pure bounded literal substitution; values are never treated as templates or code. */
export function expandDatasetSteps(content) {
  const clean = normaliseDataset(content?.dataset);
  if (clean.error) return clean;
  if (!Array.isArray(content?.steps) || content.steps.length > MAX_STEPS) return { error: 'TOO_MANY_STEPS' };
  const sourceSteps = []; const ids = new Set();
  for (const step of content.steps) {
    if (!ID.test(step?.id ?? '') || ids.has(step.id)) return { error: 'STEP_ID_INVALID' };
    ids.add(step.id);
    const out = { id: step.id };
    for (const field of ['action', 'data', 'expected']) {
      out[field] = text(step[field] ?? '');
      if (out[field] == null || out[field].length > MAX_TEXT) return { error: 'STEP_TOO_LONG' };
    }
    sourceSteps.push(out);
  }
  const dataset = clean.dataset;
  let rows = dataset?.rows ?? [{ id: 'default', values: {} }];
  if (dataset?.mode === 'COMBINATORIAL') {
    let values = [{}];
    for (const p of dataset.parameters) values = values.flatMap(row => (p.type === 'LIST' ? p.values : [p.value]).map(value => ({ ...row, [p.name]: value })));
    rows = values.map((values, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, values }));
  }
  if (rows.length * sourceSteps.length > MAX_EXPANDED_STEPS) return { error: 'TOO_MANY_EXPANDED_STEPS' };
  let total = 0;
  const iterations = []; const steps = [];
  for (const row of rows) {
    const expanded = [];
    for (const step of sourceSteps) {
      const out = { id: dataset ? `${row.id}__${step.id}` : step.id, sourceStepId: step.id, iterationId: row.id };
      for (const field of ['action', 'data', 'expected']) {
        let missing = false;
        out[field] = !dataset ? step[field] : step[field].replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_match, name) => {
          if (!Object.hasOwn(row.values, name)) { missing = true; return ''; }
          return row.values[name];
        });
        if (missing) return { error: 'PARAMETER_UNDEFINED' };
        if (out[field].length > MAX_TEXT) return { error: 'STEP_TOO_LONG' };
        total += out[field].length;
        if (total > MAX_EXPANDED_TEXT) return { error: 'DATASET_TOO_LARGE' };
      }
      expanded.push(out); steps.push(out);
    }
    iterations.push({ id: row.id, values: { ...row.values }, steps: expanded });
  }
  return frozen({ iterations, steps, digest: contentDigest({ dataset, iterations }) });
}

export function normaliseCollectionDraft(input, role) {
  const out = { objective: text(input?.objective ?? ''), text: text(input?.text ?? ''), members: [], preconditions: [],
    environment: text(input?.environment ?? ''), configurations: [], releaseId: input?.releaseId == null || input.releaseId === '' ? null : String(input.releaseId) };
  if ([out.objective, out.text, out.environment].some(v => v == null || v.length > MAX_TEXT) || out.environment.length > 255 || (out.releaseId != null && !/^\d+$/.test(out.releaseId))) return { error: 'INVALID_INPUT' };
  const members = input?.members ?? []; const conditions = input?.preconditions ?? []; const configs = input?.configurations ?? [];
  if (!Array.isArray(members) || members.length > MAX_COLLECTION_MEMBERS || !Array.isArray(conditions) || conditions.length > 50 || !Array.isArray(configs) || configs.length > 20) return { error: 'INVALID_INPUT' };
  const seen = new Set();
  for (const m of members) {
    const id = String(m?.testIssueId ?? ''); const versionId = m?.versionId == null || m.versionId === '' ? null : String(m.versionId);
    if (!/^\d+$/.test(id) || seen.has(id) || (versionId != null && !/^[a-f0-9]{32}$/.test(versionId)) || (m.required != null && typeof m.required !== 'boolean')) return { error: 'MEMBER_INVALID' };
    seen.add(id); out.members.push({ testIssueId: id, versionId, required: m.required !== false });
  }
  seen.clear();
  for (const p of conditions) {
    const issueId = String(p?.issueId ?? ''); const revisionId = p?.revisionId == null || p.revisionId === '' ? null : String(p.revisionId);
    if (!/^\d+$/.test(issueId) || (revisionId != null && !/^[a-f0-9]{32}$/.test(revisionId)) || seen.has(issueId)) return { error: 'MEMBER_INVALID' };
    seen.add(issueId); out.preconditions.push({ issueId, revisionId });
  }
  seen.clear();
  for (const c of configs) {
    const id = String(c?.id ?? ''); const name = text(c?.name);
    if (!ID.test(id) || !name?.trim() || name.length > 200 || seen.has(id)) return { error: 'INVALID_INPUT' };
    seen.add(id); out.configurations.push({ id, name });
  }
  if (role === 'PRECONDITION' && (out.members.length || out.preconditions.length)) return { error: 'MEMBER_INVALID' };
  return { draft: out };
}

export function collectionContent({ issueId, projectId, role, revisionNo, parentIssueId, draft, members, preconditions, release }) {
  return { kind: 'COLLECTION_REVISION', schema: 1, issueId: String(issueId), projectId: String(projectId), role,
    revisionNo, parentIssueId: parentIssueId == null ? null : String(parentIssueId), objective: draft.objective, text: draft.text,
    members, preconditions, environment: draft.environment, configurations: draft.configurations.map(c => ({ ...c })), release };
}
