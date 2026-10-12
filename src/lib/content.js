import { canonical, sha256Hex } from './hash.js';

/**
 * Controlled content extraction, hashing, and — this app's addition — value
 * retention.
 *
 * THE INTAKE FILTER. Only fields explicitly declared as controlled are read,
 * hashed or stored. Everything else in the issue is dropped here and never
 * reaches storage.
 *
 * Determinism is the whole game. If the same content could hash two different
 * ways, we would raise false drift; if two different contents could hash the
 * same way, a change would slip past a review. The normalisation below is
 * deliberately strict and errs toward "this is a change".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NEW HERE, AND WHY IT IS GUARDED
 *
 * Hashing alone would let this app say "we store no customer content", which is
 * the easy compliance position. Baseline cannot diff or restore without the
 * values, so project() ALSO returns them — but ONLY for fields whose
 * va_controlled_field row has store_values = true.
 *
 * That flag is not a performance switch. It is a compliance boundary, and it
 * has to be crossed explicitly: an opt-in, per-field extension behind its own
 * flag — not the default, and not silent.
 *
 * So: `values` is keyed only by fields that opted in, `digests` always covers
 * every controlled field, and the content hash is computed from the DIGESTS
 * alone. That last detail matters more than it looks — it means turning value
 * retention on or off for a field does NOT change its content hash, so an admin
 * flipping the flag cannot accidentally invalidate every standing baseline on
 * the site.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const FIELD_KIND = {
  TEXT: 'TEXT',           // summary, plain-text custom fields
  ADF: 'ADF',             // description and other rich-text fields
  SCALAR: 'SCALAR',       // number, date, select (single value)
  MULTI: 'MULTI',         // labels, components, multi-select
  ATTACHMENTS: 'ATTACHMENTS',
  LINKS: 'LINKS',
  SUBTASKS: 'SUBTASKS'
};

/**
 * Fields every baselined item is reviewed over, whether or not an admin
 * declared them.
 *
 * Title and description are the work item — an approval that did not cover them
 * would not be an approval of anything a reader would recognise.
 *
 * DEFINED ONCE, ON PURPOSE. This list feeds the hash written at capture
 * (lib/baseline.js) and the hash recomputed at every drift check
 * (lib/interception.js). If those two ever disagree about a single field, every
 * item drifts against its own baseline the moment it is created and can never
 * return to CLEAN — a permanent, self-inflicted review backlog.
 */
export const ALWAYS_CONTROLLED_FIELDS = [
  { field_id: 'summary', field_kind: 'TEXT', field_name: 'Summary' },
  { field_id: 'description', field_kind: 'ADF', field_name: 'Description' },
  { field_id: 'issuelinks', field_kind: 'LINKS', field_name: 'Linked Issues' },
  { field_id: 'subtasks', field_kind: 'SUBTASKS', field_name: 'Subtasks' }
];

/**
 * Fields that must never be tracked, whoever asks.
 *
 * TWO KINDS, AND THE SECOND KIND IS NEW.
 *
 * The first are fields whose CONTENT is not part of the reviewed record:
 * comments, worklogs, watchers. A reviewer approves the work item, not the
 * conversation around it.
 *
 * `attachment` used to be here. It is not any more: the files on a work item
 * are part of what a reviewer approves, and since the vault keeps a hashed copy
 * of every baselined file (jobs/vaultWorker.js) a rejection can put a removed
 * file back and take an added one away (lib/restore/attachments.js).
 *
 * The rest are DERIVED OR VOLATILE: Jira recomputes them, and no human edited
 * anything when they change. `lastViewed` moves when somebody merely opens the
 * item. `workratio`, the aggregate time fields and `statuscategorychangedate`
 * are recalculated by Jira. `status`, `statusCategory` and `resolutiondate`
 * change as a CONSEQUENCE of the very transition this app gates, so tracking
 * them would make every approved item drift the instant it was approved.
 * `issuekey`, `project`, `created` and `creator` cannot change at all.
 *
 * All of these appeared in a real 306-field drift record for BS-11, which is
 * what this list exists to prevent. Anything here is unavailable to the admin
 * screen too — an admin cannot opt into tracking a field that reports drift
 * nobody caused.
 */
export const IGNORED_FIELDS = new Set([
  // Not part of the reviewed record.
  'comment', 'worklog', 'watches', 'votes',
  'timetracking', 'progress', 'aggregateprogress',
  'thumbnail', 'environment',

  // Immutable — cannot drift. `reporter` is deliberately NOT here: it is
  // editable, it is in DEFAULT_LADDER, and a reporter swapped after approval is
  // exactly the kind of quiet change this app exists to catch.
  'issuekey', 'project', 'created', 'creator',

  // Recomputed by Jira, or moved by simply reading the item. `lastViewed` is the
  // worst of them — it changes when a reviewer OPENS the item to review it, so
  // tracking it makes the act of reviewing produce drift.
  'lastViewed', 'updated', 'workratio', 'statuscategorychangedate',
  'aggregatetimeestimate', 'aggregatetimeoriginalestimate', 'aggregatetimespent',
  'timespent',

  // Changed BY a transition, so tracking them would report drift on legitimate
  // workflow movement. Status is already modelled in va_review; recording it
  // twice would mean every approved item drifted the moment it moved on.
  // `resolution` is NOT here — it is set once and a later change to it is a real
  // edit worth catching — but `resolutiondate` is derived from it.
  'status', 'statusCategory', 'resolutiondate'
]);

/**
 * `declared` plus any ALWAYS_CONTROLLED_FIELDS it does not already contain.
 *
 * An admin's own declaration wins on collision: if they declared `summary` with
 * a different kind, or with store_values off, that row is left exactly as it is
 * rather than being silently replaced. The stored baseline hash was computed
 * under their kind, and overriding it here would invalidate it — and silently
 * turning on value retention for a field an admin left off would be precisely
 * the "not silent" rule broken.
 */
export function withAlwaysControlled(declared) {
  const alwaysMap = new Map(ALWAYS_CONTROLLED_FIELDS.map((f) => [f.field_id, f]));
  const out = [];

  for (const f of (declared ?? [])) {
    const always = alwaysMap.get(f.field_id);
    if (always) {
      out.push({
        ...f,
        field_kind: always.field_kind,
        // Don't override user's store_values/materiality choices if they exist
      });
    } else {
      out.push(f);
    }
  }

  const present = new Set(out.map((f) => f.field_id));
  for (const always of ALWAYS_CONTROLLED_FIELDS) {
    if (!present.has(always.field_id)) {
      out.push({ ...always, store_values: true, state: 'ACTIVE' });
    }
  }

  return out;
}

/**
 * CANDIDATES FOR TRACKING — the admin screen's menu, and nothing else.
 *
 * WHAT THIS USED TO BE, AND THE BUG THAT CAME OF IT. This function returned
 * every field Jira knows about, minus a ten-entry ignore list, and three
 * different callers treated the answer as "the tracked fields": capture.js
 * stored a baseline value for each, collect.js measured drift across each, and
 * the admin screen displayed them as already tracked. On a tenant with 300+
 * custom fields that meant a baseline of 306 fields, and a reconcile pass that
 * "found drift" on `lastViewed`, `workratio`, `statuscategorychangedate` and
 * `aggregatetimespent` — fields that change when nobody has touched the item.
 * One sweep took 142 seconds and inserted 306 drift rows for a single work item.
 *
 * Meanwhile resolvers/panel.js asked configStore.controlledFields() — the rows
 * an administrator actually declared — and got ZERO. So the panel told a
 * reviewer "Baseline will record the 0 tracked fields", computed the evidence
 * hash their signature binds to over nothing at all, and the capture then stored
 * 306. Two definitions of "tracked field" in one app, and the weaker one was
 * driving what got signed.
 *
 * THE DECLARED SET IS NOW THE ONLY AUTHORITY. This function names what an admin
 * may CHOOSE from; configStore.controlledFields() names what they chose. Nothing
 * outside the admin screen may use this to decide what to baseline or diff.
 */
export function candidateFields(jiraFields, declaredOverrides) {
  const overrides = new Map((declaredOverrides ?? []).map(f => [f.field_id, f]));
  const seen = new Set();
  const result = [];

  for (const f of jiraFields) {
    if (IGNORED_FIELDS.has(f.id)) continue;
    seen.add(f.id);

    const override = overrides.get(f.id);

    result.push({
      field_id: f.id,
      field_name: f.name,
      field_kind: override?.field_kind ?? inferFieldKind(f.schema),
      schema_type: f.schema?.type ?? null,
      store_values: override?.store_values ?? true,
      writable: override?.writable ?? null,
      materiality: override?.materiality ?? 'MINOR',
      state: 'ACTIVE'
    });
  }

  for (const f of declaredOverrides ?? []) {
    if (IGNORED_FIELDS.has(f.field_id)) continue;
    if (seen.has(f.field_id)) continue;

    result.push({
      field_id: f.field_id,
      field_name: f.field_name,
      field_kind: f.field_kind,
      schema_type: null,
      store_values: f.store_values ?? true,
      writable: f.writable ?? null,
      materiality: f.materiality ?? 'MINOR',
      state: 'ACTIVE'
    });
  }
  
  return result;
}

/**
 * Keys Jira attaches to ADF nodes that carry no authored meaning and are not
 * stable across reads. Hashing them would produce phantom drift.
 *
 * Kept deliberately short. Anything not listed here is treated as content — if
 * we are unsure whether something is meaningful, we treat it as meaningful and
 * accept a false "changed" over a missed change.
 */
const ADF_VOLATILE_KEYS = new Set(['localId', 'version']);

export function normaliseAdf(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.map(normaliseAdf);
  if (typeof node !== 'object') return node;

  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (ADF_VOLATILE_KEYS.has(key)) continue;
    out[key] = normaliseAdf(node[key]);
  }
  return out;
}

/** Plain text: normalise line endings and trailing whitespace only. */
export function normaliseText(v) {
  if (v === null || v === undefined) return null;
  // Older field configurations may classify Jira textarea documents as TEXT.
  // Never collapse every document to the same '[object Object]' digest.
  if (typeof v === 'object') return canonical(normaliseAdf(v));
  return String(v).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

/**
 * Multi-valued fields are order-insensitive in Jira's UI but the API may return
 * them in varying order. Sort so that reordering alone is not a content change.
 */
export function normaliseMulti(v) {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (x && typeof x === 'object' ? (x.accountId ?? x.id ?? x.value ?? x.name ?? canonical(x)) : x))
    .map(String)
    .sort();
}

/**
 * Attachments are compared by Jira id, which is exact: Jira never changes a
 * file in place, so different bytes always arrive under a new id, and a file
 * swapped under the same name is an add and a remove.
 *
 * The id is the CANONICAL one (lib/attachmentIdentity.js): a file the app
 * re-uploaded from the vault stands for the original it restored. Only what
 * that copy shares with its original is hashed — not `created`, `author` or
 * `mimeType`, which a re-upload changes and which say nothing about content.
 */
export function normaliseAttachments(list, issueFields = null) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => !a?.isRichText)
    .map((a) => ({
      id: String(a.id ?? ''),
      filename: a.filename ?? '',
      size: a.size ?? null
    }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function normaliseSubtasks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(t => String(t.id))
    .filter(Boolean)
    .sort();
}

export function normaliseLinks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((l) => ({
      type: l.type?.id ?? l.type?.name ?? null,
      inward: l.inwardIssue?.id ? String(l.inwardIssue.id) : null,
      outward: l.outwardIssue?.id ? String(l.outwardIssue.id) : null
    }))
    .sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
}

/**
 * A rich-text document with nothing in it.
 *
 * Jira returns `{type:'doc', version:1, content:[]}` for a rich-text field that
 * was once set and then cleared, and null for one that never was. Nobody typed
 * anything in either, so they are the same value: reading them as different made
 * a restore to "nothing" look like a change on a field with no content.
 */
export function isEmptyAdf(node) {
  return node != null && typeof node === 'object' && !Array.isArray(node)
    && node.type === 'doc' && (!Array.isArray(node.content) || node.content.length === 0);
}

export function normaliseField(kind, value, issueFields = null) {
  switch (kind) {
    case FIELD_KIND.ADF: return isEmptyAdf(value) ? null : normaliseAdf(value);
    case FIELD_KIND.TEXT: return normaliseText(value);
    case FIELD_KIND.MULTI: return normaliseMulti(value);
    case FIELD_KIND.ATTACHMENTS: return normaliseAttachments(value, issueFields);
    case FIELD_KIND.LINKS: return normaliseLinks(value);
    case FIELD_KIND.SUBTASKS: return normaliseSubtasks(value);
    case FIELD_KIND.SCALAR:
      if (value === undefined) return null;
      if (value && typeof value === 'object') {
        if (value.child != null) return canonical({ parent: value.id ?? value.value ?? null,
          child: value.child.id ?? value.child.value ?? value.child });
        return value.accountId ?? value.id ?? value.value ?? value.name ?? canonical(value);
      }
      return value;
    default:
      throw new TypeError(`unknown controlled field kind: ${kind}`);
  }
}

/**
 * Build the controlled projection of an issue.
 *
 * @param issueFields  the `fields` object from GET /rest/api/3/issue/{key}
 * @param controlledFields [{ field_id, field_kind, field_name, store_values }]
 *
 * Returns:
 *   contentHash  sha256 over the digest map. Independent of store_values.
 *   digests      { fieldId: sha256 } for EVERY controlled field.
 *   values       { fieldId: normalisedValue } for retained fields ONLY.
 *   raw          { fieldId: rawValue } for retained fields ONLY — the
 *                pre-normalisation value, which is what a restore has to write
 *                back. Normalisation is lossy on purpose (it sorts multi-values
 *                and strips ADF localIds); writing a normalised value back into
 *                Jira would be a second, silent edit.
 */
export function project(issueFields, controlledFields) {
  const values = {};
  const raw = {};
  const digests = {};

  for (const field of [...controlledFields].sort((a, b) => (a.field_id < b.field_id ? -1 : 1))) {
    const { field_id, field_kind } = field;
    const rawValue = issueFields?.[field_id];
    const normalised = normaliseField(field_kind, rawValue, issueFields);

    digests[field_id] = sha256Hex(canonical({ f: field_id, k: field_kind, v: normalised }));

    // THE BOUNDARY. Nothing but an explicit store_values = true puts customer
    // content into `values`/`raw`, and therefore into the database.
    if (field.store_values === true) {
      values[field_id] = normalised;
      raw[field_id] = rawValue === undefined ? null : rawValue;
    }
  }

  // Computed from digests alone, so toggling retention never changes a hash.
  const contentHash = sha256Hex(canonical(digests));
  return { contentHash, digests, values, raw };
}

/**
 * Which fields of THIS WORK ITEM differ between two projections.
 *
 * ─── DRIFT IS A FACT ABOUT THE ITEM, NOT ABOUT THE TRACKED SET ───────────────
 *
 * `scopeIds` is the set of fields in scope for the item right now, and passing
 * it is what keeps this function answering the question it claims to answer.
 * observe() has always passed it. This function used to accept two arguments
 * and drop it on the floor, and the result was the worst class of bug this app
 * can have: it reported changes to work items that nobody had touched.
 *
 * Unioning the two key sets makes every difference in MEMBERSHIP look like a
 * difference in VALUE, because a key that is absent on one side reads as null
 * and null !== a digest. So:
 *
 *   · A baseline captured when the project tracked 302 fields, compared against
 *     a projection over the 4 in scope, reported 298 fields as changed. That is
 *     BS-21's `inserted:302, driftCount:604` — on an untouched item — and
 *     BS-11's 14 fields from the reconcile sweep.
 *   · Every field an administrator deliberately EXCLUDED came back as drift on
 *     every approved item, once, for ever.
 *   · The evidence hash is computed over the same arithmetic, so the reviewer
 *     was told "this work item changed while you were reading it" about an item
 *     that had not changed — and the decision was refused as STALE_EVIDENCE.
 *
 * TWO RULES, AND BOTH ARE ABOUT WHAT AN APPROVAL MEANT.
 *
 *   1. OUT OF SCOPE IS NOT DRIFT. A field the item no longer tracks cannot have
 *      drifted on the item. The tracked set narrowing is a configuration change;
 *      it has an author and a timestamp in the ledger (EVENT.CONFIG_CHANGED) and
 *      that is where it belongs, not on a reviewer's screen as a changed field.
 *
 *   2. NOT IN THE BASELINE IS NOT DRIFT. A newly tracked field has no approved
 *      value to have drifted FROM. Counting it would mean that installing an
 *      unrelated app which adds a custom field marks every approved item in the
 *      tenant as drifted — the exact failure trackedFields.js was written to
 *      prevent. It is covered from the next baseline onward, which is the only
 *      point at which a reviewer has actually approved it.
 *
 * Called WITHOUT `scopeIds` the old union behaviour stands, because with no
 * scope there is no way to tell a set change from a value change and the safe
 * reading of an unknown difference is "changed". Callers that know their scope
 * are expected to say so.
 */
/**
 * Two stored digests for one field, read as the same value or not.
 *
 * Equal digests are the same value. The one exception is a baseline stored
 * before an empty rich-text document was read as "no value": its digest for an
 * empty document differs from the digest of a field that was never set, and
 * both mean nothing. Those baselines stay valid rather than drifting.
 */
export function digestsEquivalent(fieldId, a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (x == null || y == null) return false;
  const none = sha256Hex(canonical({ f: fieldId, k: FIELD_KIND.ADF, v: null }));
  const legacyEmpty = sha256Hex(canonical({ f: fieldId, k: FIELD_KIND.ADF, v: normaliseAdf({ type: 'doc', version: 1, content: [] }) }));
  return (x === none && y === legacyEmpty) || (x === legacyEmpty && y === none);
}

export function changedFields(prevDigests, nextDigests, scopeIds = null) {
  const prev = prevDigests ?? {};
  const next = nextDigests ?? {};

  // Rule 2 is expressed here rather than in the loop: comparison is restricted
  // to keys the BASELINE actually carries, so a field with no approved value is
  // never a candidate in the first place.
  const keys = scopeIds
    ? [...new Set(scopeIds)].filter((k) => Object.prototype.hasOwnProperty.call(prev, k))
    : [...new Set([...Object.keys(prev), ...Object.keys(next)])];

  const changed = [];
  for (const k of keys.sort()) {
    if (!digestsEquivalent(k, prev[k], next[k])) changed.push(k);
  }
  return changed;
}

export const GENESIS_CONTENT = '0'.repeat(64);

/**
 * Map a Jira field schema to a FIELD_KIND.
 *
 * Used by the admin console when an administrator adds a field, so they are not
 * asked to classify `customfield_10042` themselves. Advisory only — the stored
 * `field_kind` is what everything else reads, and an admin may override this.
 *
 * Unknown types fall back to SCALAR rather than throwing: a custom field this
 * function has never heard of should still be hashable, and SCALAR's
 * `id ?? value ?? name ?? canonical(x)` handles an arbitrary object safely.
 */
export function inferFieldKind(schema) {
  if (!schema) return FIELD_KIND.SCALAR;
  const { type, items, system } = schema;

  if (type === 'doc') return FIELD_KIND.ADF;
  if (system === 'attachment' || items === 'attachment') return FIELD_KIND.ATTACHMENTS;
  if (system === 'issuelinks' || items === 'issuelinks') return FIELD_KIND.LINKS;
  if (system === 'subtasks' || items === 'subtasks') return FIELD_KIND.MULTI;
  if (type === 'array') return FIELD_KIND.MULTI;
  if (type === 'string') {
    // Jira reports both single-line and multi-line text as `string`. Only the
    // rich-text ones arrive as `doc`, handled above.
    return FIELD_KIND.TEXT;
  }
  return FIELD_KIND.SCALAR;
}
