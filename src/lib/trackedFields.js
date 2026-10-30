import api, { route } from '@forge/api';

import { candidateFields, ALWAYS_CONTROLLED_FIELDS } from './content.js';
import { DEFAULT_LADDER, DEFAULT_MATERIALITY } from './materiality.js';
import {
  declaredFieldRows, seedControlledFields, countControlledFields
} from '../db/configStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

/**
 * Track candidate Jira fields unless an administrator excluded them.
 * content.js IGNORED_FIELDS excludes volatile fields that change without edits.
 *
 * Persist the tracked set in va_controlled_field. The validator uses one indexed
 * read within its roughly ten-second budget. Resolving Jira's catalogue at
 * runtime would change baseline comparisons when apps add fields, without a
 * reviewer ever approving that field set.
 *
 * Adopt fields through gate save, the administrator's Sync action or field
 * search. Record the author and time in the ledger. Do not change the tracked
 * set on a schedule or during comparison with an existing baseline.
 */

/**
 * Bound pagination inside the resolver's time limit. The endpoint caps
 * maxResults at 200.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * Read one issue type's fields from
 * GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}.
 * The response uses fields, with results as its alias, and total for pagination.
 * It has no documented values or isLast. Keep values only as a fallback for
 * additional response properties.
 *
 * @returns true if Jira answered, false if the read failed. Distinguish an empty
 * scope from a failed request so callers do not narrow the tracked set.
 */
async function readIssueTypeFields(projectId, issueTypeId, sink) {
  let startAt = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.asApp().requestJira(
      route`/rest/api/3/issue/createmeta/${projectId}/issuetypes/${issueTypeId}?startAt=${startAt}&maxResults=${PAGE_SIZE}`
    );
    if (!res.ok) return false;

    const body = await res.json();
    const batch = Array.isArray(body.fields) ? body.fields
      : Array.isArray(body.results) ? body.results
        : Array.isArray(body.values) ? body.values
          : [];

    for (const f of batch) {
      // FieldCreateMetadata's identifier is `fieldId`; `key` is its documented
      // twin. Neither is optional, but a field with no id cannot be tracked and
      // must not become an `undefined` entry in the scope set.
      const id = f?.fieldId ?? f?.key ?? f?.id;
      if (id && !sink.has(id)) sink.set(id, { ...f, id });
    }

    // Use total because this response has no isLast. Also stop on an empty page
    // to avoid a loop if metadata changes during pagination.
    if (batch.length === 0) break;
    startAt += batch.length;
    const total = Number(body.total);
    if (Number.isFinite(total) && startAt >= total) break;
  }

  return true;
}

/**
 * Require catalogue metadata before adopting screen fields. Its schema
 * determines the kind, and later syncs never rewrite existing rows.
 * If the catalogue is unavailable, adopt nothing and retry at the next sync.
 * @returns the number of fields added to sink
 */
export function adoptScreenFields({ screenFields, catalogue, sink }) {
  const catalogueById = new Map((catalogue ?? []).map((field) => [String(field.id), field]));
  let added = 0;
  for (const [id, field] of screenFields) {
    const entry = catalogueById.get(id);
    if (!entry || sink.has(id)) continue;
    sink.set(id, { ...field, ...entry, id });
    added++;
  }
  return added;
}

/**
 * Bound screen reads per resolver request. Each screen requires a tabs read
 * and a read per tab. Sync requests subsequent batches and persists each
 * batch's adopted fields without keeping state between requests.
 */
export const SCREEN_BATCH = 60;

/**
 * Read sorted screen ids in batches. Stable configuration gives consecutive
 * offsets complete coverage. The next Sync picks up screens added mid-read.
 * @returns { ids, total, nextOffset }, with null nextOffset after the last batch
 */
export function screenBatch(screenIds, offset = 0, size = SCREEN_BATCH) {
  const all = [...new Set([...screenIds].map(String))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const start = Number.isInteger(offset) && offset > 0 ? Math.min(offset, all.length) : 0;
  const ids = all.slice(start, start + size);
  const end = start + ids.length;
  return { ids, total: all.length, nextOffset: end < all.length ? end : null };
}

export function screenIdsForIssueType({ issueTypeId, mappings = [], screenSchemes = [], workflow = null }) {
  const mapping = mappings.find((item) => String(item.issueTypeId) === String(issueTypeId))
    ?? mappings.find((item) => String(item.issueTypeId) === 'default');
  const scheme = mapping && screenSchemes.find((item) => String(item.id) === String(mapping.screenSchemeId));
  const ids = new Set(Object.values(scheme?.screens ?? {}).filter(Boolean).map(String));
  for (const transition of workflow?.transitions ?? []) {
    const screenId = transition?.transitionScreen?.parameters?.screenId ?? transition?.transitionScreen?.id;
    if (screenId) ids.add(String(screenId));
  }
  return [...ids];
}

/**
 * Add fields from every configured create/edit/view and transition screen.
 * Jira's create-metadata endpoint deliberately reports only the create screen;
 * without this union, a retirement-only rationale or review-only classification
 * can never be selected for retention even though it is authored content.
 */
async function readProjectScreenFields(projectId, issueTypeIds, sink, { offset = 0 } = {}) {
  const client = api.asApp();
  const { readWorkflowForPair } = await import('./workflowSource.js');
  const failed = (step, response) => {
    console.warn(`trackedFields: ${step} failed while reading project screens`, response?.status);
    return { ok: false, total: null, nextOffset: null };
  };
  const projectSchemes = await client.requestJira(
    route`/rest/api/3/issuetypescreenscheme/project?projectId=${projectId}`
  );
  if (!projectSchemes.ok) return failed('work type screen scheme', projectSchemes);
  const projectBody = await projectSchemes.json();
  const issueTypeScreenSchemeId = projectBody.values?.[0]?.issueTypeScreenScheme?.id;
  if (!issueTypeScreenSchemeId) {
    console.warn('trackedFields: Jira returned no work type screen scheme for project', projectId);
    return { ok: false, total: null, nextOffset: null };
  }

  const mappings = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.requestJira(
      route`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${issueTypeScreenSchemeId}&startAt=${startAt}&maxResults=${PAGE_SIZE}`
    );
    if (!response.ok) return failed('work type screen mappings', response);
    const body = await response.json();
    const batch = body.values ?? [];
    mappings.push(...batch);
    if (!batch.length || body.isLast || (body.total != null && mappings.length >= body.total)) break;
    startAt += batch.length;
  }

  const relevantSchemeIds = new Set();
  for (const issueTypeId of issueTypeIds) {
    const mapping = mappings.find((item) => String(item.issueTypeId) === String(issueTypeId))
      ?? mappings.find((item) => String(item.issueTypeId) === 'default');
    if (mapping?.screenSchemeId) relevantSchemeIds.add(String(mapping.screenSchemeId));
  }

  const screenSchemes = [];
  for (const screenSchemeId of relevantSchemeIds) {
    const response = await client.requestJira(
      route`/rest/api/3/screenscheme?id=${screenSchemeId}&startAt=0&maxResults=${PAGE_SIZE}`
    );
    if (!response.ok) {
      failed(`screen scheme ${screenSchemeId}`, response);
      continue;
    }
    const body = await response.json();
    screenSchemes.push(...(body.values ?? []));
  }

  const workflows = new Map();
  const CONCURRENCY = 5;
  for (let i = 0; i < issueTypeIds.length; i += CONCURRENCY) {
    const batch = issueTypeIds.slice(i, i + CONCURRENCY);
    const values = await Promise.all(batch.map(async (issueTypeId) => [
      issueTypeId,
      await readWorkflowForPair({ projectId, issueTypeId })
    ]));
    for (const [issueTypeId, workflow] of values) workflows.set(String(issueTypeId), workflow);
  }

  const screenIds = new Set();
  for (const issueTypeId of issueTypeIds) {
    for (const screenId of screenIdsForIssueType({
      issueTypeId,
      mappings,
      screenSchemes,
      workflow: workflows.get(String(issueTypeId))
    })) screenIds.add(screenId);
  }

  const batchPlan = screenBatch(screenIds, offset);
  const screenFields = new Map();
  const allScreenIds = batchPlan.ids;
  for (let i = 0; i < allScreenIds.length; i += CONCURRENCY) {
    const batch = allScreenIds.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (screenId) => {
      const tabsResponse = await client.requestJira(route`/rest/api/3/screens/${screenId}/tabs`);
      if (!tabsResponse.ok) return;
      const tabs = await tabsResponse.json();
      for (const tab of tabs ?? []) {
        const fieldsResponse = await client.requestJira(route`/rest/api/3/screens/${screenId}/tabs/${tab.id}/fields`);
        if (!fieldsResponse.ok) continue;
        for (const field of await fieldsResponse.json()) {
          if (field?.id) screenFields.set(String(field.id), field);
        }
      }
    }));
  }

  const catalogueResponse = await client.requestJira(route`/rest/api/3/field`);
  if (!catalogueResponse.ok) return failed('field catalogue', catalogueResponse);
  adoptScreenFields({ screenFields, catalogue: await catalogueResponse.json(), sink });
  console.info('trackedFields: project screen discovery', JSON.stringify({ projectId, issueTypes: issueTypeIds.length, screens: batchPlan.total, offset, read: allScreenIds.length, fields: screenFields.size }));
  return { ok: true, total: batchPlan.total, nextOffset: batchPlan.nextOffset };
}

/**
 * Read the project's field catalogue. Return [] on failure so Sync adopts
 * nothing and retries later. This result cannot distinguish a failed read
 * from an empty catalogue. Use scopeFromIssue for comparisons instead.
 */
export async function readScopeFields(projectId, issueTypeId) {
  return (await readScopeFieldsBatch(projectId, issueTypeId)).fields;
}

/**
 * readScopeFields plus one batch of screens, starting at `screenOffset`.
 * `screens.nextOffset` is null when the batch was the last one; `screens.ok`
 * is false when the screen read failed, in which case the create-screen fields
 * are still returned and nothing is claimed about the rest.
 */
export async function readScopeFieldsBatch(projectId, issueTypeId, { screenOffset = 0 } = {}) {
  const none = { fields: [], screens: { ok: false, total: null, nextOffset: null } };
  try {
    let issueTypes = [issueTypeId];
    if (issueTypeId === '*') {
      const pRes = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`);
      if (!pRes.ok) return none;
      const pBody = await pRes.json();
      if (Array.isArray(pBody.issueTypes)) {
        issueTypes = pBody.issueTypes.map((it) => String(it.id));
      }
    }

    const fieldMap = new Map();
    const CONCURRENCY = 5;
    for (let i = 0; i < issueTypes.length; i += CONCURRENCY) {
      const batch = issueTypes.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((it) => readIssueTypeFields(projectId, it, fieldMap)));
    }

    const screens = await readProjectScreenFields(projectId, issueTypes, fieldMap, { offset: screenOffset });

    return { fields: Array.from(fieldMap.values()), screens };
  } catch (e) {
    console.error('trackedFields: could not read Jira scope fields', e);
    return none;
  }
}

/**
 * Resolve declared fields for capture, panel reads and collection from the
 * issue's existing fields response. Callers read fields=*all, including null
 * values. This pure function avoids network-dependent evidence hashes.
 *
 * If no fields were returned, keep the declared set rather than narrowing it.
 * changedFields compares only fields present in the baseline, so a wider set
 * does not invent drift.
 */
export const SCOPE_BASIS = {
  /** The issue's edit screen. What a person means by "the fields on this issue". */
  SCREEN: 'SCREEN',
  /** Every field in the project's field configuration. Wide, but issue-shaped. */
  ISSUE: 'ISSUE',
  /** Nothing could be determined. The declared rows, unnarrowed. */
  DECLARED: 'DECLARED'
};

export function scopeFromIssue({ declared, issueFields, editmetaFields = null }) {
  const rows = declared ?? [];
  // Include ALWAYS_CONTROLLED_FIELDS at every tier. subtasks is read-only
  // and absent from editmeta, but still requires protection.
  const always = new Set(ALWAYS_CONTROLLED_FIELDS.map((f) => f.field_id));
  const pick = (allowed, basis) => ({
    fields: rows.filter((f) => allowed.has(f.field_id) || always.has(f.field_id)),
    basis
  });

  // Use all administrator-declared fields regardless of issue screen or type,
  // as requested by the user. Ignore the older scoping logic.
  return { fields: rows, basis: SCOPE_BASIS.DECLARED };
}

/**
 * Select fields to adopt without I/O. A candidate must exist in Jira, be
 * outside IGNORED_FIELDS and have no declared row in any state.
 * Pass all declared rows, including EXCLUDED, so sync cannot undo an
 * administrator's exclusions.
 */
export function fieldsToAdopt(jiraFields, declared) {
  const known = new Set((declared ?? []).map((f) => f.field_id));
  return candidateFields(jiraFields ?? [], declared ?? [])
    .filter((f) => !known.has(f.field_id))
    .map((f) => ({
      ...f,
      materiality: DEFAULT_LADDER[f.field_id] ?? DEFAULT_MATERIALITY
    }));
}

/**
 * Bring one project/issue-type scope up to "everything is tracked".
 *
 * Writes an ACTIVE row for every candidate field that has no row at all, and
 * preserves every existing row, including administrator exclusions.
 *
 * @returns { ok, added, tracked, excluded, skipped }
 */
export async function syncTrackedFields({
  projectId, issueTypeId = '*', accountId, jiraFields = null, screenOffset = 0, now = Date.now()
}) {
  const pid = Number(projectId);
  if (!Number.isFinite(pid)) return { ok: false, error: 'NO_PROJECT' };

  const read = jiraFields ? { fields: jiraFields, screens: null } : await readScopeFieldsBatch(projectId, issueTypeId, { screenOffset });
  const fields = read.fields;
  if (fields.length === 0) {
    // The catalogue read failed. Saying so beats reporting "0 added" as though
    // the project were already complete.
    return { ok: false, error: 'CATALOGUE_UNAVAILABLE', added: 0 };
  }

  const declared = await declaredFieldRows({ projectId: pid, issueTypeId });
  const missing = fieldsToAdopt(fields, declared);

  let added = 0;
  if (missing.length > 0) {
    const res = await seedControlledFields({
      projectId: pid, issueTypeId, fields: missing, accountId, now
    });
    added = res.inserted;
  }

  const tracked = await countControlledFields({ projectId: pid });

  if (added > 0) {
    // Audit tracked-set changes so later baseline coverage can be attributed
    // to an administrator or the hourly backfill.
    await tryAppend({
      actorAccountId: accountId ?? 'system',
      eventType: EVENT.CONFIG_CHANGED,
      issueId: null,
      payload: {
        scope: 'trackedFields',
        projectId: pid,
        issueTypeId,
        added,
        trackedAfter: tracked,
        fieldIds: missing.map((f) => f.field_id)
      }
    });
  }

  return {
    ok: true,
    added,
    tracked,
    excluded: declared.filter((f) => f.state === 'EXCLUDED').length,
    screens: read.screens
  };
}
