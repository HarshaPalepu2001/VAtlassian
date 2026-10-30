import { canonical, sha256Hex } from './hash.js';

/**
 * Extract controlled content, compute hashes and retain opted-in values.
 *
 * Read, hash and store only explicitly controlled fields. Other issue fields
 * do not enter storage. Normalisation must be deterministic so identical
 * content produces identical digests and changed content remains detectable.
 *
 * project() returns raw values only for fields whose va_controlled_field row
 * has store_values = true. Value retention is an explicit per-field opt-in
 * because diff and restore need content that a digest alone cannot provide.
 *
 * values contains opted-in fields. digests covers every controlled field, and
 * the content hash depends on digests alone. Changing value-retention settings
 * therefore does not change a field's content hash or invalidate its baseline.
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
 * Always include these fields in baseline review, even without an explicit
 * administrator declaration. Title and description identify the approved work.
 *
 * Capture in lib/baseline.js and drift checks in lib/interception.js share this
 * list. Different sets would make an item drift against its own new baseline.
 */
export const ALWAYS_CONTROLLED_FIELDS = [
  { field_id: 'summary', field_kind: 'TEXT', field_name: 'Summary' },
  { field_id: 'description', field_kind: 'ADF', field_name: 'Description' },
  { field_id: 'issuelinks', field_kind: 'LINKS', field_name: 'Linked Issues' },
  { field_id: 'subtasks', field_kind: 'SUBTASKS', field_name: 'Subtasks' }
];

/**
 * Fields that administrators cannot opt into tracking.
 *
 * Comments, worklogs and watchers are outside the reviewed content. Attachments
 * are tracked: jobs/vaultWorker.js keeps hashed baseline copies and
 * lib/restore/attachments.js restores removed files or deletes added ones.
 *
 * Also exclude derived or volatile fields. Opening an item changes lastViewed;
 * Jira recomputes workratio, aggregate time and statuscategorychangedate.
 * status, statusCategory and resolutiondate change during the gated transition
 * itself. issuekey, project, created and creator are treated here as immutable.
 * Tracking these fields caused 306 false drift rows for BS-11.
 */
export const IGNORED_FIELDS = new Set([
  // Not part of the reviewed record.
  'comment', 'worklog', 'watches', 'votes',
  'timetracking', 'progress', 'aggregateprogress',
  'thumbnail', 'environment',

  // These fields cannot drift here. Keep reporter trackable because it is
  // editable and DEFAULT_LADDER assigns its materiality.
  'issuekey', 'project', 'created', 'creator',

  // Jira recomputes these fields. Opening the item changes lastViewed, so
  // tracking it would make review itself produce drift.
  'lastViewed', 'updated', 'workratio', 'statuscategorychangedate',
  'aggregatetimeestimate', 'aggregatetimeoriginalestimate', 'aggregatetimespent',
  'timespent',

  // The transition changes these fields. Tracking them would report drift on
  // approved workflow movement; va_review already records status. Keep resolution
  // trackable because a later explicit change matters; resolutiondate is derived.
  'status', 'statusCategory', 'resolutiondate'
]);

/**
 * Add missing ALWAYS_CONTROLLED_FIELDS to declared fields.
 *
 * Preserve an administrator's existing row on collision, including its kind
 * and store_values flag. Replacing the kind could invalidate the stored hash;
 * enabling retention would override the administrator's explicit opt-out.
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
 * List candidate fields for the admin picker, not the tracked-field set.
 *
 * Previously, capture.js and collect.js treated this catalogue as configuration.
 * A tenant with over 300 custom fields produced a 306-field baseline and a
 * 142-second sweep inserting 306 drift rows, including volatile lastViewed,
 * workratio, statuscategorychangedate and aggregatetimespent. Meanwhile the
 * panel read zero configured fields and bound the signature to that empty set.
 *
 * configStore.controlledFields() is the authority for fields to baseline or diff.
 * Only the admin picker may use this function to list fields available to choose.
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
 * ADF keys without authored meaning that Jira may change between reads.
 * Ignore only these known keys. Treat other attributes as content to avoid
 * missing a meaningful change, even if that sometimes reports extra drift.
 */
const ADF_VOLATILE_KEYS = new Set(['localId', 'version']);

/**
 * Walk ADF iteratively to avoid recursive call-stack limits, previously
 * reached near 2,000 levels. Jira ADF is a tree, so unlike logical-node graphs
 * it needs no visited set for cycles.
 */
export function normaliseAdf(node) {
  const rootHolder = {};
  const stack = [{ value: node, parent: rootHolder, key: 'v' }];

  while (stack.length > 0) {
    const { value, parent, key } = stack.pop();

    if (value === null || value === undefined) {
      parent[key] = null;
    } else if (Array.isArray(value)) {
      const out = new Array(value.length);
      parent[key] = out;
      for (let i = 0; i < value.length; i++) {
        stack.push({ value: value[i], parent: out, key: i });
      }
    } else if (typeof value !== 'object') {
      parent[key] = value;
    } else {
      const out = {};
      parent[key] = out;
      // Push descending keys so the LIFO stack processes them in ascending order.
      // This preserves key insertion order and JSON.stringify/for-in output byte for
      // byte against the original recursive implementation.
      const keys = Object.keys(value).sort();
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        if (ADF_VOLATILE_KEYS.has(k)) continue;
        stack.push({ value: value[k], parent: out, key: k });
      }
    }
  }

  return rootHolder.v;
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
 * Compare attachments by canonical Jira ID. Jira never changes a file's bytes
 * in place; replacing a same-named file is an add and remove.
 *
 * lib/attachmentIdentity.js maps a restored copy to its original ID. Hash only
 * the attributes both share. Re-uploading changes created, author and mimeType,
 * which do not identify the approved bytes.
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
 * @param issueFields The fields object from GET /rest/api/3/issue/{key}.
 * @param controlledFields [{ field_id, field_kind, field_name, store_values }].
 *
 * Return contentHash, a SHA-256 of the digest map independent of store_values;
 * digests, the hash for each controlled field; values, normalised retained
 * values; and raw, the retained pre-normalisation values used for restore.
 * Normalisation sorts multi-values and strips ADF localIds, so writing its
 * output back would introduce changes beyond the restore.
 */
export function project(issueFields, controlledFields, context = {}) {
  const values = {};
  const raw = {};
  const digests = {};

  for (const field of [...controlledFields].sort((a, b) => (a.field_id < b.field_id ? -1 : 1))) {
    const { field_id, field_kind } = field;
    const original = issueFields?.[field_id];
    const rawValue = field_kind === FIELD_KIND.LINKS
      ? governedLinks(original, { ...context, issue: context.issue ?? { fields: issueFields } }) : original;
    const normalised = normaliseField(field_kind, rawValue, issueFields);

    digests[field_id] = fieldDigest(field, normalised, context);

    // Require explicit store_values = true before adding customer content to
    // values/raw or storing it in the database.
    if (field.store_values === true) {
      values[field_id] = normalised;
      raw[field_id] = rawValue === undefined ? null : rawValue;
    }
  }

  // Computed from digests alone, so toggling retention never changes a hash.
  const contentHash = sha256Hex(canonical(digests));
  return { contentHash, digests, values, raw };
}

/** Shared by projection, diff, derived baselines and restore suppression. */
export function fieldDigest(field, normalised, { linkPolicy } = {}) {
  const policy = normaliseLinkPolicy(linkPolicy);
  return sha256Hex(canonical({ f: field.field_id, k: field.field_kind, v: normalised,
    ...(field.field_kind === FIELD_KIND.LINKS && policy.version === 2 ? { linkPolicy: policy } : {}) }));
}

/**
 * Find value differences within the item's current tracked scope.
 *
 * scopeIds limits comparison to fields the item now tracks. Comparing the union
 * of old and new digest keys instead treated scope changes as content edits.
 * A 302-field baseline compared with four current fields reported 298 false
 * changes. BS-21 recorded inserted:302, driftCount:604; BS-11 showed 14 fields
 * from a sweep. The same arithmetic produced false STALE_EVIDENCE refusals.
 *
 * An excluded field is a configuration change recorded by EVENT.CONFIG_CHANGED,
 * not drift on the item. A newly tracked field has no approved value to compare
 * until the next baseline. Do not count either case as a changed value.
 *
 * observe() supplies scopeIds. Without it, retain the legacy union comparison:
 * unknown scope cannot distinguish membership changes from value changes.
 */
/**
 * Two stored digests for one field, read as the same value or not.
 *
 * Equal digests are the same value. The one exception is a baseline stored
 * before an empty rich-text document was read as "no value": its digest for an
 * empty document differs from the digest of a field that was never set, and
 * both mean nothing. Those baselines stay valid rather than drifting.
 */
const ADF_EMPTY_DOC = { type: 'doc', version: 1, content: [] };
const EQUIVALENT_DIGESTS_CACHE = new Map();

function getEquivalentDigests(fieldId) {
  let cached = EQUIVALENT_DIGESTS_CACHE.get(fieldId);
  if (!cached) {
    const none = sha256Hex(canonical({ f: fieldId, k: FIELD_KIND.ADF, v: null }));
    const legacyEmpty = sha256Hex(canonical({ f: fieldId, k: FIELD_KIND.ADF, v: normaliseAdf(ADF_EMPTY_DOC) }));
    cached = { none, legacyEmpty };
    if (EQUIVALENT_DIGESTS_CACHE.size < 500) EQUIVALENT_DIGESTS_CACHE.set(fieldId, cached);
  }
  return cached;
}

export function digestsEquivalent(fieldId, a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (x == null || y == null) return false;
  const { none, legacyEmpty } = getEquivalentDigests(fieldId);
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
 * Suggest a FIELD_KIND from Jira schema for the admin field picker.
 * The stored field_kind remains authoritative and an administrator may override
 * this suggestion. Unknown types use SCALAR instead of throwing;
 * id ?? value ?? name ?? canonical(x) handles arbitrary objects.
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
import { governedLinks, normaliseLinkPolicy } from './linkPolicy.js';
