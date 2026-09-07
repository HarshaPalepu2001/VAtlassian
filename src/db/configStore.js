import { executeQuery, toBinaryParam, fromBinaryColumn, limitClause } from '../lib/db.js';
import { newId, throwing } from './store.js';
import { withAlwaysControlled } from '../lib/content.js';
import { effectiveAssurance } from '../lib/approval/levels.js';

/**
 * va_config, va_controlled_transition, va_controlled_field, va_eligibility.
 *
 * Everything an administrator sets, and the queries the gate and the panel ask
 * of it. Read paths here are on the ~10s validator budget, so each one is a
 * single indexed statement and none of them fans out.
 */

const ACTIVE = 'ACTIVE';

// ── va_config ────────────────────────────────────────────────────────────────

export async function getConfig(key, fallback = null) {
  const rows = await throwing('SELECT cfg_value FROM va_config WHERE cfg_key = ?', [key]);
  if (rows.length === 0) return fallback;
  try {
    return JSON.parse(rows[0].cfg_value);
  } catch {
    // A config row that will not parse is a corrupt row, not a reason to take
    // the app down. Falling back to the default means the app runs on its
    // documented defaults rather than refusing to start, and the admin console
    // shows the row as unreadable so somebody can fix it.
    console.error('config: unparseable value for', key);
    return fallback;
  }
}

export async function setConfig(key, value, updatedBy, now) {
  await throwing(
    `REPLACE INTO va_config (cfg_key, cfg_value, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
    [key, JSON.stringify(value), now, updatedBy]
  );
}

/**
 * Per-project settings, with site defaults underneath.
 *
 * Merged rather than inherited-by-reference so that a project which has never
 * been configured behaves identically to one configured with the defaults —
 * there is no "unset" state that behaves differently from an explicit choice.
 */
export const DEFAULT_PROJECT_CONFIG = {
  enabled: true,
  /** Status ids that count as "in review". Transitions OUT of these are gated. */
  reviewStatusIds: [],
  /** Materiality at or above which drift enters a reviewer's queue. */
  queueThreshold: 'MINOR',
  /** Reviewer-only is the default; see ARCHITECTURE.md §12. */
  visibility: 'reviewer-only',
  ai: {
    enabled: true,
    models: {
      light: 'claude-haiku-4-5-20251001',
      standard: 'claude-sonnet-4-6',
      deep: 'claude-opus-4-8'
    },
    maxCompletionTokens: 4096
  },
  restore: {
    /** Writes are attributed to the app by default: a clean audit line, and no
     *  per-user permission surprises mid-rejection. */
    actAs: 'app',
    notifyUsers: false,
    perFieldRetries: 2,
    commentOnRestore: true
  },
  notifications: {
    digest: true,
    digestAfterHours: 24
  },
  policy: {
    mode: 'DETECT'
  }
};

export async function projectConfig(projectId) {
  const [site, project] = await Promise.all([
    getConfig('site', {}),
    getConfig(`project:${projectId}`, {})
  ]);
  return deepMerge(deepMerge(DEFAULT_PROJECT_CONFIG, site ?? {}), project ?? {});
}

export async function isStrictMode(projectId) {
  const config = await projectConfig(projectId);
  return config?.policy?.mode === 'STRICT';
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// ── va_controlled_transition ──────────────────────────────────────────────────────

/**
 * Is this exact edge gated?
 *
 * `(from_status_id = ? OR from_status_id = '*')` with `ORDER BY from_status_id
 * DESC` — and the ordering is the subtle part: '*' sorts below any real status
 * id, so an exact row always wins over the wildcard. That is what lets an admin
 * write "gate everything out of Review" as one row and then override one
 * specific edge without deleting it.
 *
 * The wildcard is what keeps that promise true over time. A review
 * status typically has several outbound transitions and gains more over time;
 * per-edge configuration silently stops covering the new ones, and nobody
 * notices until an unreviewed item walks straight through a transition that was
 * added last month.
 *
 * ISSUE TYPE TAKES THE WILDCARD TOO, and it is not optional. The admin console
 * saves a gate as `issue_type_id = '*'` — a project's review status means the
 * same thing for a Story as for a Bug, and nobody wants to configure the gate
 * once per issue type. Matching that column exactly would mean the console can
 * only ever write rows this query cannot find, so no work item would ever be
 * baselined and NOTHING WOULD LOOK BROKEN: the trigger would report NOT_A_GATE,
 * which is the ordinary case for most transitions and is not even logged.
 */
export async function gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId }) {
  const rows = await throwing(
    `SELECT TO_BASE64(ct_id) AS ct_id, required_role, meaning, require_decision, block_on_drift, required_assurance, capture_baseline
     FROM va_controlled_transition
     WHERE project_id = ?
       AND (issue_type_id = ? OR issue_type_id = '*')
       AND (from_status_id = ? OR from_status_id = '*')
       AND (to_status_id = ? OR to_status_id = '*')
       AND state = ?
     ORDER BY issue_type_id DESC, from_status_id DESC, to_status_id DESC
     LIMIT 1`,
    [projectId, issueTypeId, fromStatusId, toStatusId, ACTIVE]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ct_id: fromBinaryColumn(r.ct_id),
    required_role: r.required_role,
    meaning: r.meaning,
    // Forge SQL returns BOOLEAN as 0/1. Coerced here so no caller has to
    // remember that `if (row.require_decision)` is true for the string "0".
    require_decision: !!Number(r.require_decision),
    block_on_drift: !!Number(r.block_on_drift),
    required_assurance: r.required_assurance,
    capture_baseline: !!Number(r.capture_baseline)
  };
}


export async function gateActiveOutOf({ projectId, issueTypeId, fromStatusId }) {
  const rows = await throwing(
    `SELECT required_role, meaning, required_assurance, capture_baseline, block_on_drift FROM va_controlled_transition
     WHERE project_id = ?
       AND (issue_type_id = ? OR issue_type_id = '*')
       AND (from_status_id = ? OR from_status_id = '*')
       AND state = ?
     ORDER BY issue_type_id DESC, from_status_id DESC
     LIMIT 1`,
    [projectId, issueTypeId, fromStatusId, ACTIVE]
  );
  return rows.length > 0 ? { gated: true, required_role: rows[0].required_role, required_assurance: rows[0].required_assurance, capture_baseline: !!Number(rows[0].capture_baseline), block_on_drift: !!Number(rows[0].block_on_drift), meaning: rows[0].meaning } : { gated: false, required_role: null };
}

/** Back-compat name for the panel's `authRequired` flag. Same question now. */
export async function requireAuthFor(scope) {
  const { gated } = await gateActiveOutOf(scope);
  return gated;
}

/** Every review status configured for a project, for supersedeOnReviewEntry. */
export async function reviewStatusIds(projectId) {
  const rows = await throwing(
    `SELECT DISTINCT from_status_id FROM va_controlled_transition
     WHERE project_id = ? AND state = ? AND from_status_id <> '*'`,
    [projectId, ACTIVE]
  );
  return rows.map((r) => String(r.from_status_id));
}

/**
 * WHERE A DRIFTED ITEM IN THIS PROJECT SHOULD BE SENT BACK TO.
 *
 * reviewStatusIds() answers "which statuses count as review", which is the
 * question for deciding whether an item is ALREADY in front of a reviewer. This
 * answers the different question of which one to move it TO, and a project with
 * two gated statuses needs both answers to be separate.
 *
 * MOST SPECIFIC WINS, the same precedence va_controlled_field uses: a gate
 * naming this issue type beats a project-wide '*' gate, and among equals the
 * most recently configured one — an admin's latest statement of intent.
 *
 * `from_status_id <> '*'` because a wildcard gate says "out of any status",
 * which is not somewhere an item can be put.
 */
export async function recallTargetStatus({ projectId, issueTypeId }) {
  const rows = await throwing(
    `SELECT from_status_id, issue_type_id FROM va_controlled_transition
     WHERE project_id = ? AND state = ? AND from_status_id <> '*'
       AND (issue_type_id = ? OR issue_type_id = '*')
     ORDER BY issue_type_id DESC, created_at DESC
     LIMIT ${limitClause(1)}`,
    [projectId, ACTIVE, String(issueTypeId)]
  );
  return rows.length > 0 ? String(rows[0].from_status_id) : null;
}

/**
 * Every (project, review status) pair that is gated anywhere in the tenant.
 *
 * reviewStatusIds() above answers the same question for ONE project, which is
 * what the capture path needs. The review page needs it for all of them at
 * once: a reviewer holding a site-wide grant may have work waiting in nine
 * projects, and asking per project would be nine round trips before the page
 * can even build its JQL.
 *
 * `from_status_id <> '*'` for the same reason reviewStatusIds excludes it — a
 * wildcard gate says "out of any status", which is not a status anybody sits
 * in and cannot be searched for.
 */
export async function gatedReviewStatuses() {
  const rows = await throwing(
    `SELECT DISTINCT project_id, from_status_id, required_role FROM va_controlled_transition
     WHERE state = ? AND from_status_id <> '*'
     LIMIT ${limitClause(2000)}`,
    [ACTIVE]
  );
  // The role comes back on the triple rather than being looked up separately,
  // because one status can be the source of several gated edges with DIFFERENT
  // required roles — "out of Review to Done needs APPROVER, out of Review back
  // to In Progress needs REVIEWER" is an ordinary configuration. Collapsing
  // them to one role per status would either hide items from somebody who can
  // decide them or offer items to somebody who cannot.
  return rows.map((r) => ({
    projectId: Number(r.project_id),
    statusId: String(r.from_status_id),
    role: r.required_role ?? null
  }));
}

export async function listGatedTransitions(projectId) {
  const rows = await throwing(
    `SELECT TO_BASE64(ct_id) AS ct_id, project_id, issue_type_id, from_status_id, to_status_id,
            transition_id, required_role, meaning, require_decision, block_on_drift, required_assurance, capture_baseline, state, created_at, created_by
     FROM va_controlled_transition WHERE project_id = ? ORDER BY created_at DESC LIMIT ${limitClause(200)}`,
    [projectId]
  );
  return rows.map((r) => ({
    ...r,
    ct_id: fromBinaryColumn(r.ct_id).toString('hex'),
    require_decision: !!Number(r.require_decision),
    block_on_drift: !!Number(r.block_on_drift),
    required_assurance: r.required_assurance,
    capture_baseline: !!Number(r.capture_baseline)
  }));
}

/**
 * Every project/issue-type scope that has a gate, across the whole install.
 *
 * The backfill's work list. DISTINCT rather than the full rows because the job
 * only needs to know which scopes claim to be protected, so it can check
 * whether they actually track anything.
 */
export async function gatedScopes() {
  const rows = await throwing(
    `SELECT DISTINCT project_id, issue_type_id
     FROM va_controlled_transition WHERE state = ? LIMIT ${limitClause(500)}`,
    [ACTIVE]
  );
  return rows.map((r) => ({
    projectId: Number(r.project_id),
    issueTypeId: String(r.issue_type_id)
  }));
}

export async function deleteGatedTransition(id) {
  await throwing(
    'DELETE FROM va_controlled_transition WHERE ct_id = FROM_BASE64(?)',
    [toBinaryParam(id)]
  );
}


export async function upsertGatedTransition(row) {
  const id = row.ct_id ?? newId();
  await throwing(
    `REPLACE INTO va_controlled_transition
     (ct_id, project_id, issue_type_id, from_status_id, to_status_id, transition_id,
      required_role, meaning, require_decision, block_on_drift, required_assurance, capture_baseline, state, created_at, created_by)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toBinaryParam(id), row.project_id, row.issue_type_id, row.from_status_id, row.to_status_id,
      // Recorded, never matched on. See migrations.js v034.
      row.transition_id ?? null,
      row.required_role, row.meaning ?? 'Approved', row.require_decision === false ? 0 : 1, row.block_on_drift === false ? 0 : 1,
      effectiveAssurance(row.required_assurance), row.capture_baseline === false ? 0 : 1, row.state ?? ACTIVE, row.created_at, row.created_by
    ]
  );
  return id;
}

/**
 * How many people hold each role in this project, for the gate screen.
 *
 * A gate naming a role nobody holds denies every transition with
 * NO_ELIGIBLE_REVIEWER, and the admin who configured it has no way to see that
 * from the gate screen — the rule looks perfectly well formed. This is what
 * lets the screen say "0 people hold this" at the moment the choice is made,
 * rather than leaving it to be discovered by a reviewer who cannot move a
 * ticket.
 *
 * Counts site-wide grants (project_id IS NULL) too, because those genuinely do
 * authorise here — the same predicate lib/eligibility.js uses.
 */
export async function roleHolderCounts(projectId) {
  const rows = await throwing(
    `SELECT role, COUNT(DISTINCT account_id) AS holders
     FROM va_eligibility
     WHERE state = ? AND (project_id = ? OR project_id IS NULL)
     GROUP BY role`,
    [ACTIVE, projectId == null ? null : String(projectId)]
  );
  const out = {};
  for (const r of rows) out[String(r.role)] = Number(r.holders ?? 0);
  return out;
}

// ── va_controlled_field ──────────────────────────────────────────────────────

/**
 * The intake filter for one project/issue type, with summary and description
 * always present.
 *
 * `issue_type_id = '*'` is a project-wide declaration and is what the console
 * writes by default; a row naming a specific issue type overrides it for that
 * type only.
 *
 * withAlwaysControlled() adds them if an admin has not, and adds them with
 * `store_values: false` — an app must not start retaining the contents of a
 * field because of a default. If the admin wants description diffs, they turn
 * retention on for description explicitly, on a screen that says what that
 * means.
 */
export async function controlledFields({ projectId, issueTypeId }) {
  const rows = await throwing(
    `SELECT TO_BASE64(cf_id) AS cf_id, field_id, field_name, field_kind, schema_type,
            store_values, writable, materiality
     FROM va_controlled_field
     WHERE project_id = ?
       AND (issue_type_id = ? OR issue_type_id = '*')
       AND state = ?
     ORDER BY issue_type_id DESC`,
    [projectId, issueTypeId, ACTIVE]
  );
  // ORDER BY issue_type_id DESC puts an exact-issue-type row ahead of the '*'
  // row for the same field, and the Map keeps the first of each field_id — so a
  // per-type override wins over the project-wide default rather than appearing
  // beside it as a duplicate.
  const byField = new Map();
  for (const r of rows) if (!byField.has(r.field_id)) byField.set(r.field_id, r);
  const declared = [...byField.values()].map((r) => ({
    cf_id: fromBinaryColumn(r.cf_id).toString('hex'),
    field_id: r.field_id,
    field_name: r.field_name,
    field_kind: r.field_kind,
    schema_type: r.schema_type,
    store_values: !!Number(r.store_values),
    writable: r.writable == null ? null : !!Number(r.writable),
    materiality: r.materiality
  }));
  return withAlwaysControlled(declared);
}

export async function deleteControlledField({ projectId, issueTypeId, fieldId }) {
  await throwing(
    'DELETE FROM va_controlled_field WHERE project_id = ? AND issue_type_id = ? AND field_id = ?',
    [projectId, issueTypeId, fieldId]
  );
}

/**
 * EVERY declared row for this scope, whatever its state — including EXCLUDED.
 *
 * controlledFields() answers "what is tracked" and therefore filters to ACTIVE.
 * That is the right answer for capture, drift and the panel, and the WRONG
 * answer for anything deciding what to WRITE, because an EXCLUDED row is
 * invisible to it. The admin screen fed controlledFields() into candidateFields
 * as the override map, so a field an admin had deliberately excluded came back
 * in the "available to track" list on the very next render — the exclusion
 * looked like it had not saved.
 *
 * It is also what makes seeding safe. A seed that cannot see EXCLUDED rows
 * would resurrect every field an admin had turned off, every hour, forever.
 */
export async function declaredFieldRows({ projectId, issueTypeId }) {
  const rows = await throwing(
    `SELECT TO_BASE64(cf_id) AS cf_id, field_id, field_name, field_kind, schema_type,
            store_values, writable, materiality, state, issue_type_id
     FROM va_controlled_field
     WHERE project_id = ?
       AND (issue_type_id = ? OR issue_type_id = '*')
     ORDER BY issue_type_id DESC`,
    [projectId, issueTypeId]
  );
  const byField = new Map();
  for (const r of rows) if (!byField.has(r.field_id)) byField.set(r.field_id, r);
  return [...byField.values()].map((r) => ({
    cf_id: fromBinaryColumn(r.cf_id).toString('hex'),
    field_id: r.field_id,
    field_name: r.field_name,
    field_kind: r.field_kind,
    schema_type: r.schema_type,
    store_values: !!Number(r.store_values),
    writable: r.writable == null ? null : !!Number(r.writable),
    materiality: r.materiality,
    state: r.state,
    issue_type_id: r.issue_type_id
  }));
}

/**
 * TRACK A SET OF FIELDS, IDEMPOTENTLY.
 *
 * The write half of track-by-default. Inserts one ACTIVE row per field that has
 * no row yet, in chunks, and returns how many it added.
 *
 * A FIELD THAT ALREADY HAS A ROW IS NEVER TOUCHED. Not updated, not replaced —
 * skipped. That single rule is what lets this run on a schedule without
 * fighting the administrator: an EXCLUDED row stays excluded, a row whose
 * materiality or retention was tuned by hand keeps its tuning, and re-running
 * the seed on an already-seeded project inserts nothing.
 *
 * Chunked because Forge SQL takes one statement per call with no transaction
 * around it. A tenant with 300 custom fields is a 300-row insert; sending it as
 * one statement risks the payload limit, and sending it as 300 statements takes
 * long enough that the caller times out. Forty at a time is one statement per
 * chunk and eight chunks for a big tenant. A chunk that fails leaves the chunks
 * before it in place, which is correct — the next run inserts the rest.
 */
export async function seedControlledFields({ projectId, issueTypeId, fields, accountId, now }) {
  if (!Array.isArray(fields) || fields.length === 0) return { inserted: 0 };

  const CHUNK = 40;
  let inserted = 0;

  for (let i = 0; i < fields.length; i += CHUNK) {
    const chunk = fields.slice(i, i + CHUNK);
    const params = [];
    const tuples = [];

    for (const f of chunk) {
      tuples.push('(FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        toBinaryParam(newId()), projectId, issueTypeId,
        String(f.field_id), String(f.field_name ?? f.field_id), String(f.field_kind),
        f.schema_type ?? null,
        f.store_values === true ? 1 : 0,
        f.writable == null ? null : (f.writable ? 1 : 0),
        String(f.materiality ?? 'MINOR'),
        ACTIVE, now, accountId
      );
    }

    await throwing(
      `INSERT INTO va_controlled_field
       (cf_id, project_id, issue_type_id, field_id, field_name, field_kind, schema_type,
        store_values, writable, materiality, state, created_at, created_by)
       VALUES ${tuples.join(', ')}`,
      params
    );
    inserted += chunk.length;
  }

  return { inserted };
}

/**
 * How many fields this project tracks, across every issue type.
 *
 * The backfill's trigger condition. Cheap enough to ask every hour for every
 * gated project, and served by idx_cf_lookup.
 */
export async function countControlledFields({ projectId }) {
  const rows = await throwing(
    'SELECT COUNT(*) AS n FROM va_controlled_field WHERE project_id = ? AND state = ?',
    [projectId, ACTIVE]
  );
  return Number(rows?.[0]?.n ?? 0);
}

/**
 * UPSERT, AND IT HAD TO EARN THE NAME.
 *
 * va_controlled_field's primary key is cf_id, and nothing else about it is
 * unique — there is no key on (project_id, issue_type_id, field_id). So a
 * REPLACE INTO with a freshly minted cf_id collides with nothing and INSERTS.
 * Every caller that did not already hold a cf_id was therefore appending a row
 * rather than updating one: Exclude, then Track, then Exclude again left three
 * rows for the same field, and controlledFields()'s first-wins Map picked
 * whichever the ORDER BY happened to surface. A field's tracked state depended
 * on row order.
 *
 * Looking the id up first is the fix that does not need a schema change. A
 * unique index would be better and cannot be added safely while duplicate rows
 * from the old behaviour are still in the table; this collapses them instead —
 * the lookup takes the newest, and the REPLACE overwrites it in place.
 */
export async function upsertControlledField(row) {
  let id = row.cf_id ?? null;

  if (!id) {
    const existing = await throwing(
      `SELECT TO_BASE64(cf_id) AS cf_id FROM va_controlled_field
       WHERE project_id = ? AND issue_type_id = ? AND field_id = ?
       ORDER BY created_at DESC`,
      [row.project_id, row.issue_type_id, row.field_id]
    );
    if (existing.length > 0) id = fromBinaryColumn(existing[0].cf_id);

    // Any older duplicates this field accumulated before the lookup existed.
    // Removed here rather than in a migration because a DELETE is not DDL and
    // the migration runner only executes DDL.
    if (existing.length > 1) {
      await throwing(
        `DELETE FROM va_controlled_field
         WHERE project_id = ? AND issue_type_id = ? AND field_id = ? AND cf_id <> FROM_BASE64(?)`,
        [row.project_id, row.issue_type_id, row.field_id, toBinaryParam(id)]
      );
    }
  }

  if (!id) id = newId();
  await throwing(
    `REPLACE INTO va_controlled_field
     (cf_id, project_id, issue_type_id, field_id, field_name, field_kind, schema_type,
      store_values, writable, materiality, state, created_at, created_by)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toBinaryParam(id), row.project_id, row.issue_type_id, row.field_id, row.field_name,
      row.field_kind, row.schema_type ?? null,
      row.store_values ? 1 : 0,
      row.writable == null ? null : (row.writable ? 1 : 0),
      row.materiality ?? 'MINOR',
      row.state ?? ACTIVE, row.created_at, row.created_by
    ]
  );
  return id;
}

/**
 * Turn value retention on or off for one field.
 *
 * Its own function rather than a generic update, because this is the single
 * most consequential setting in the app and every call site must audit it. The
 * resolver that calls this writes FIELD_RETENTION_CHANGED to the ledger; that
 * pairing is the only reason storing values at all is defensible.
 *
 * Turning retention OFF deletes nothing already stored. That is deliberate: the
 * stored values belong to baselines a reviewer may still be looking at, and
 * silently voiding them would break a diff mid-review. The daily prune removes
 * them as those baselines are superseded, and the admin screen says so.
 */
export async function setFieldRetention({ projectId, issueTypeId, fieldId, storeValues }) {
  const result = await executeQuery(
    `UPDATE va_controlled_field SET store_values = ?
     WHERE project_id = ? AND issue_type_id = ? AND field_id = ?`,
    [storeValues ? 1 : 0, projectId, issueTypeId, fieldId]
  );
  return result.result;
}

// ── va_eligibility ──────────────────────────────────────────────────────────────

export async function listReviewers({ projectId = null } = {}) {
  const scope = projectId == null ? 'WHERE state = ?' : 'WHERE (project_id = ? OR project_id IS NULL) AND state = ?';
  const params = projectId == null ? [ACTIVE] : [projectId, ACTIVE];
  const rows = await throwing(
    `SELECT TO_BASE64(el_id) AS el_id, account_id, display_name, issue_type_id, project_id,
            role, state, granted_at, granted_by
     FROM va_eligibility ${scope}
     ORDER BY granted_at DESC LIMIT ${limitClause(500)}`,
    params
  );
  return rows.map((r) => ({ ...r, el_id: fromBinaryColumn(r.el_id).toString('hex') }));
}

export async function upsertReviewer(row) {
  const id = row.el_id ?? newId();
  await throwing(
    `REPLACE INTO va_eligibility
     (el_id, account_id, display_name, issue_type_id, project_id, role, state, granted_at, granted_by)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toBinaryParam(id), row.account_id, row.display_name, row.issue_type_id,
      row.project_id == null ? null : row.project_id,
      row.role, row.state ?? ACTIVE, row.granted_at, row.granted_by
    ]
  );
  return id;
}

export async function revokeReviewer(rvId) {
  await executeQuery(
    `UPDATE va_eligibility SET state = 'REVOKED' WHERE el_id = FROM_BASE64(?)`,
    [toBinaryParam(rvId)]
  );
}
