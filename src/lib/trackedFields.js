import api, { route } from '@forge/api';

import { candidateFields, ALWAYS_CONTROLLED_FIELDS } from './content.js';
import { DEFAULT_LADDER, DEFAULT_MATERIALITY } from './materiality.js';
import {
  declaredFieldRows, seedControlledFields, countControlledFields
} from '../db/configStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';

/**
 * TRACK EVERY FIELD UNLESS SOMEBODY SAID NOT TO.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * This app has swung between two definitions of "tracked field" and shipped
 * both of them broken.
 *
 * The FIRST definition was "everything Jira has". It produced a 306-field
 * baseline for BS-11 and a reconcile pass that reported drift on `lastViewed`,
 * `workratio` and `statuscategorychangedate` — fields that move when nobody has
 * touched the work item. One sweep took 142 seconds. That was rightly killed.
 *
 * The SECOND definition, put in to fix it, was "only rows an administrator
 * declared". va_controlled_field was empty on every project, so the honest
 * answer to "what is tracked" became NOTHING: the panel told a reviewer
 * "Baseline will record the 0 tracked fields", computed the evidence hash their
 * signature binds to over an empty set, and the review gate protected nothing
 * on a project whose administrator had configured a gate and reasonably assumed
 * it was working. Zero is a worse default than 306, because 306 was noisy and
 * zero is silently empty.
 *
 * NEITHER DEFAULT WAS THE PRODUCT DECISION. The decision is: baseline every
 * field, minus a short list deliberately left out because tracking it would
 * report drift nobody caused. That list is content.js's IGNORED_FIELDS, and it
 * is the thing that makes track-by-default safe now and unsafe before — the
 * first definition had ten entries in it and none of the volatile ones.
 *
 * ─── WHY IT IS MATERIALISED RATHER THAN COMPUTED ─────────────────────────────
 *
 * "Every candidate field" could be computed on the fly from Jira's /field
 * catalogue. It is not, for three reasons, and the third is the one that
 * matters.
 *
 *   1. The gate runs on a ~10s validator budget and asks what is tracked. A
 *      REST round trip inside that budget is a risk with no upside.
 *   2. configStore.controlledFields() stays a single indexed read, and stays
 *      the ONLY authority on what is tracked. Nothing gains a second opinion.
 *   3. A baseline's hash is computed over a field set. If that set were derived
 *      live from Jira's catalogue, installing an unrelated app that adds a
 *      custom field would silently change what every existing baseline is
 *      compared against — every approved item in the tenant would drift, and
 *      the evidence would say a reviewer had signed something they had not.
 *      Writing rows down makes the tracked set a recorded decision with an
 *      author and a timestamp, which is what the ledger needs it to be.
 *
 * So new fields are adopted by an explicit act — on gate save, on the admin's
 * Sync button, or one at a time from the field search — and never on a
 * schedule or by surprise mid-baseline.
 */

/**
 * The endpoint caps maxResults at 200. MAX_PAGES is a hard stop, in the spirit
 * of fetchChangelog's: a paginated read inside a resolver that cannot state its
 * own worst case is a timeout waiting to happen.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * One issue type's fields, paged.
 *
 * ─── THE RESPONSE SHAPE, WHICH THIS READ GOT WRONG ───────────────────────────
 *
 * GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}
 * returns `PageOfCreateMetaIssueTypeWithField`. Its complete property set is:
 *
 *     fields, maxResults, results, startAt, total
 *
 * There is NO `values` and NO `isLast`. This function read `body.values` and
 * terminated on `body.isLast ?? true`, so on every call it collected nothing
 * and stopped after one page — readScopeFields returned [] on every tenant,
 * always, and fast enough that it never looked like a failure.
 *
 * The damage was not "no fields". It was that [] is indistinguishable from a
 * genuinely empty scope, so every caller SILENTLY NARROWED: capture, the panel
 * and the collector each fell back to the four ALWAYS_CONTROLLED_FIELDS while
 * the drift path compared against baselines taken over 302. That mismatch is
 * what put phantom drift on untouched work items.
 *
 * `values` is kept as a last resort only because the schema is declared
 * `additionalProperties: true`; `fields` is the documented name and `results`
 * its documented alias.
 *
 * @returns true if Jira answered, false if it did not — the caller must be able
 *          to tell "no fields" from "could not ask".
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

    // Termination is driven by `total`, because `isLast` does not exist on this
    // response. An empty page ends it too — that is the belt for a `total` Jira
    // declines to send.
    if (batch.length === 0) break;
    startAt += batch.length;
    const total = Number(body.total);
    if (Number.isFinite(total) && startAt >= total) break;
  }

  return true;
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
async function readProjectScreenFields(projectId, issueTypeIds, sink) {
  const client = api.asApp();
  const { readWorkflowForPair } = await import('./workflowSource.js');
  const failed = (step, response) => {
    console.warn(`trackedFields: ${step} failed while reading project screens`, response?.status);
    return false;
  };
  const projectSchemes = await client.requestJira(
    route`/rest/api/3/issuetypescreenscheme/project?projectId=${projectId}`
  );
  if (!projectSchemes.ok) return failed('work type screen scheme', projectSchemes);
  const projectBody = await projectSchemes.json();
  const issueTypeScreenSchemeId = projectBody.values?.[0]?.issueTypeScreenScheme?.id;
  if (!issueTypeScreenSchemeId) {
    console.warn('trackedFields: Jira returned no work type screen scheme for project', projectId);
    return false;
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

  const screenFields = new Map();
  const allScreenIds = [...screenIds];
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
  const catalogue = catalogueResponse.ok ? await catalogueResponse.json() : [];
  const catalogueById = new Map((catalogue ?? []).map((field) => [String(field.id), field]));
  for (const [id, field] of screenFields) {
    if (!sink.has(id)) sink.set(id, { ...field, ...catalogueById.get(id), id });
  }
  console.info('trackedFields: project screen discovery', JSON.stringify({ projectId, issueTypes: issueTypeIds.length, screens: screenIds.size, fields: screenFields.size }));
  return true;
}

/**
 * Jira's field catalogue for a project scope.
 *
 * Returns [] on failure rather than throwing: a SYNC that cannot read the
 * catalogue must do nothing and try again, never conclude that the tenant has
 * no fields and treat that as an answer.
 *
 * FOR SCOPING A COMPARISON, USE scopeFromIssue() BELOW, NOT THIS. [] here is
 * ambiguous by design, and reading it as "this issue has no fields" is the
 * mistake that narrowed three separate call sites to four hardcoded ids.
 */
export async function readScopeFields(projectId, issueTypeId) {
  try {
    let issueTypes = [issueTypeId];
    if (issueTypeId === '*') {
      const pRes = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`);
      if (!pRes.ok) return [];
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

    await readProjectScreenFields(projectId, issueTypes, fieldMap);

    return Array.from(fieldMap.values());
  } catch (e) {
    console.error('trackedFields: could not read Jira scope fields', e);
    return [];
  }
}

/**
 * WHICH DECLARED FIELDS ARE IN SCOPE FOR ONE WORK ITEM — the single definition,
 * so capture, the panel and the collector cannot disagree about it.
 *
 * ─── SCOPED FROM THE ISSUE, NOT FROM A SECOND REST CALL ──────────────────────
 *
 * The scope is `Object.keys(issue.fields)`. Every path that needs it —
 * capture.js, collect.js and both hash sites in resolvers/panel.js — already
 * reads the issue with `?fields=*all`, so the answer is free, and Jira returns
 * applicable fields including the ones sitting at null.
 *
 * IT IS A PURE FUNCTION ON PURPOSE, AND THAT IS THE FIX. The previous version
 * asked createmeta over the network. That made the evidence hash depend on a
 * live REST call, so the SAME work item could hash differently between the
 * panel rendering it and the resolver re-deriving it seconds later — a call
 * that succeeded once and failed once is all it took. The reviewer was then
 * told "this work item changed while you were reading it" about an item that
 * had not changed, and their decision was refused.
 *
 * A hash that a reviewer's signature binds to cannot depend on whether a
 * network call happened to succeed. Derived from the issue read that both sides
 * already perform, the two computations agree by construction.
 *
 * ─── WHY IT WAS THREE COPIES BEFORE ──────────────────────────────────────────
 *
 * capture.js, resolvers/panel.js and collect.js each held the same six lines,
 * each falling back to the same four literal field ids. Three copies of a rule
 * is three chances to disagree, and they did: panel:getState hashed one set and
 * authoriseFirstApproval hashed another, so EVERY first approval was refused as
 * STALE_EVIDENCE.
 *
 * ─── AND WHY AN UNKNOWN SCOPE WIDENS RATHER THAN NARROWS ─────────────────────
 *
 * If the issue read produced no fields at all, the honest answer is "unknown",
 * and the safe handling of unknown is to keep the DECLARED set — never to
 * substitute a guess. Narrowing on failure is what invented drift: a set that
 * is too WIDE reports nothing false now that changedFields() compares only
 * fields the baseline carries, while a set that is too NARROW still lies.
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
  // ALWAYS_CONTROLLED_FIELDS, not four literals. These are the fields the
  // reviewed record is actually made of, and they are force-included at every
  // tier — `subtasks` in particular is not editable and so never appears in
  // editmeta, and dropping it would quietly stop protecting it.
  const always = new Set(ALWAYS_CONTROLLED_FIELDS.map((f) => f.field_id));
  const pick = (allowed, basis) => ({
    fields: rows.filter((f) => allowed.has(f.field_id) || always.has(f.field_id)),
    basis
  });

  // ── HARDCODED TO DECLARED FIELDS ──────────────────────────────────────────
  //
  // As requested by the user, we bypass issue scoping (which is often flawed
  // due to missing editmeta permissions or fields not being on the screen)
  // and we do NOT fallback to the raw issue fields (which introduces hundreds
  // of empty custom fields).
  //
  // We simply track exactly the fields that are declared as active in the
  // config (i.e. not excluded in the Fields & Retention page).
  return { fields: rows, basis: SCOPE_BASIS.DECLARED };
}

/**
 * WHICH FIELDS THIS SCOPE SHOULD START TRACKING — the whole decision, as a pure
 * function, so it can be tested without a database or a Jira tenant.
 *
 * A field is adopted only if ALL of these hold:
 *   · Jira has it
 *   · it is not in IGNORED_FIELDS — content.js's list of fields that report
 *     drift nobody caused, which is what makes track-by-default safe
 *   · this scope has NO row for it, in any state
 *
 * THE LAST CLAUSE IS THE LOAD-BEARING ONE. `declared` must be every row
 * including EXCLUDED, not just the ACTIVE ones. Given only the ACTIVE rows this
 * function would propose re-adopting every field an administrator had
 * deliberately turned off, and every sync would undo their decision, with an
 * audit entry each time claiming the system had widened the tracked set.
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
 * leaves every existing row exactly as it is — so this is safe to call on a
 * schedule, and an administrator's exclusions survive it.
 *
 * @returns { ok, added, tracked, excluded, skipped }
 */
export async function syncTrackedFields({
  projectId, issueTypeId = '*', accountId, jiraFields = null, now = Date.now()
}) {
  const pid = Number(projectId);
  if (!Number.isFinite(pid)) return { ok: false, error: 'NO_PROJECT' };

  const fields = jiraFields ?? await readScopeFields(projectId, issueTypeId);
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
    // AUDITED, because this changes what a signature will mean. A baseline
    // captured after this sync covers fields the previous one did not, so the
    // ledger has to be able to say when the tracked set widened and who caused
    // it — including when "who" is the hourly backfill.
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
    excluded: declared.filter((f) => f.state === 'EXCLUDED').length
  };
}
