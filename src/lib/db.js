import { sql } from '@forge/sql';

/**
 * Forge SQL access.
 *
 * Every comment below records something learned the hard way against a live
 * tenant. None of it is inferable from the docs alone. Do not "simplify" any of
 * it.
 */

function scrubErrorMessage(message) {
  if (typeof message !== 'string' || !message) return undefined;
  return message
    .split('\n')[0]
    .replace(/'(?:[^'\\]|\\.)*'/g, "'[redacted]'")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"[redacted]"')
    .replace(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b[\s\S]*/i, '[sql omitted]')
    .slice(0, 300);
}

export function sqlErrorSummary(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: error?.code ?? error?.context?.debug?.code,
    status: error?.status ?? error?.context?.status ?? error?.context?.debug?.status,
    message: scrubErrorMessage(error?.message)
  };
}

export function sqlStatementSummary(statement) {
  const text = typeof statement === 'string' ? statement.trim().replace(/\s+/g, ' ') : '';
  const operation = text.match(/^([a-z]+)/i)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  const tables = new Set();
  const tablePattern = /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+([a-zA-Z0-9_]+)/gi;
  for (let match; (match = tablePattern.exec(text));) tables.add(match[1]);
  return { operation, tables: [...tables], placeholders: (text.match(/\?/g) ?? []).length };
}

/**
 * Slow-query threshold, in milliseconds, for the per-query log line below.
 *
 * Forge SQL documents a 5 s SELECT / 10 s DML query timeout (see the "Known
 * bounds" section of docs/PERFORMANCE-CHECKLIST.md). A query already past 2 s
 * — 40% of the tightest of those budgets — is worth a loud line before it
 * ever reaches the platform's own timeout, not after.
 */
export const SLOW_QUERY_MS = 2000;

/**
 * Logs every query's duration, and separately tags one that crosses
 * `thresholdMs`. This IS the SQL wrapper's own alert: there is no outbound
 * delivery for it the way lib/alerts.js delivers a security event to Jira.
 * That pipeline exists specifically for 21 CFR 11.300(d) unauthorized-use
 * detection, and db/alertStore.js implements it by calling executeQuery — so
 * routing a slow-query signal through it would both conflate a performance
 * concern with a compliance one and risk a query alerting on its own
 * slowness. A distinguishable, always-on structured line, tagged so it is
 * trivially greppable/alertable from log collection, is the honest scope of
 * "alert" the wrapper can make on its own.
 */
function logQueryDuration(queryText, durationMs, thresholdMs, succeeded) {
  const summary = sqlStatementSummary(queryText);
  if (durationMs >= thresholdMs) {
    console.warn('[SLOW_QUERY_ALERT]', JSON.stringify({ ...summary, durationMs, thresholdMs, succeeded }));
  } else {
    console.log('Forge SQL query', JSON.stringify({ ...summary, durationMs, succeeded }));
  }
}

/**
 * Executes a Forge SQL query with parameter binding.
 * Fails closed upon encountering exceptions.
 *
 * @param {string} queryText - The SQL query with ? placeholders.
 * @param {Array<any>} params - The parameters to bind.
 * @param {{ slowQueryMs?: number }} [options] - slowQueryMs overrides
 *   SLOW_QUERY_MS; only tests should ever pass it.
 */
export async function executeQuery(queryText, params = [], { slowQueryMs = SLOW_QUERY_MS } = {}) {
  const startedAt = Date.now();
  try {
    // The installed @forge/sql exposes `bindParams`, not `bind` — `.bind()`
    // isn't a method on SqlStatement at all. Result shape is
    // `{ rows, metadata }`, not `{ rows, meta }`.
    const result = await sql.prepare(queryText).bindParams(...params).execute();
    const durationMs = Date.now() - startedAt;
    logQueryDuration(queryText, durationMs, slowQueryMs, true);
    return {
      result: true,
      data: result.rows,
      meta: result.metadata,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    console.error('Forge SQL Error:', sqlErrorSummary(error), 'Statement:', sqlStatementSummary(queryText));
    logQueryDuration(queryText, durationMs, slowQueryMs, false);
    return {
      result: false,
      error,
      durationMs,
    };
  }
}

/**
 * Forge SQL's wire protocol is JSON end to end, and BINARY/VARBINARY/BLOB
 * columns come back as String. A raw Buffer bound as a query parameter does
 * NOT travel as binary — it gets JSON.stringify'd into
 * `{"type":"Buffer","data":[...]}`, which is not a valid value for a VARBINARY
 * column and fails the write.
 *
 * The fix used throughout: base64-encode a Buffer on the JS side with
 * `toBinaryParam`, bind it as a normal string parameter, and wrap that
 * placeholder in `FROM_BASE64(?)` in the SQL text. Read it back with
 * `TO_BASE64(column) AS column` and decode with `fromBinaryColumn`.
 */
export function toBinaryParam(buffer) {
  if (typeof buffer === 'string') {
    if (/^[0-9a-f]{32}$/i.test(buffer)) {
      return Buffer.from(buffer, 'hex').toString('base64');
    }
    return buffer;
  }
  if (!buffer) return '';
  return Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64');
}

export function fromBinaryColumn(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value, 'base64');
}

/**
 * How many rows an INSERT/UPDATE/DELETE actually touched.
 *
 * For a non-SELECT, Forge SQL puts an `UpdateQueryResponse` on `rows` rather
 * than an array, so the count lives at `data.affectedRows`. This matters for
 * every compare-and-swap in this app: a lost race affects zero rows and
 * otherwise succeeds silently. Returns null when the shape isn't
 * recognisable, so callers can tell "not reported" from "zero rows".
 */
export function affectedRows(result) {
  const count = result && result.data && result.data.affectedRows;
  return typeof count === 'number' ? count : null;
}

/**
 * A LIMIT count, inlined into the SQL text rather than bound.
 *
 * Forge SQL / TiDB REFUSES a placeholder in LIMIT: `LIMIT ?` returns
 * `ERROR 1210 (HY000): Incorrect arguments to LIMIT`. Confirmed in production
 * against a live tenant, not inferred.
 *
 * Inlining a value into SQL is normally the thing not to do. It is safe here
 * and only here because the value is forced through Number.isSafeInteger and a
 * positive-bound check first: what reaches the query text is a JS integer this
 * function produced, never caller-supplied text. Anything else throws rather
 * than being coerced.
 */
export function limitClause(count) {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new TypeError(`LIMIT must be a positive safe integer (got ${String(count)})`);
  }
  return String(count);
}

/**
 * Is this error "that column does not exist yet"?
 *
 * FORGE SQL APPLIES DDL ON A SCHEDULE, NOT AT DEPLOY. jobs/migrate.js runs from
 * the five-minute trigger, so between a deploy and that trigger firing, the code
 * is new and the schema is old. Every read path in this app already tolerates a
 * missing TABLE — that is why executeQuery returns `{ result: false }` instead
 * of throwing — but a missing COLUMN on a table that does exist was not covered,
 * and it fails the whole statement.
 *
 * Whoever adds a migration that widens a hot table needs this: without it, the
 * window between deploy and migration is one where every query naming the new
 * column fails, and for va_signature that means every gated approval in the
 * tenant refuses. A control that takes the product down for five minutes each
 * deploy will be removed by the next person who is on call.
 *
 * Matched on the driver's code where it survives the wrapper, and on the message
 * otherwise — same belt-and-braces reasoning as isDuplicateKey in db/store.js.
 */
export function isUnknownColumn(error) {
  const code = error?.code === 'ER_BAD_FIELD_ERROR' ? error.code : error?.context?.debug?.code;
  return code === 'ER_BAD_FIELD_ERROR' || /unknown column/i.test(error?.message ?? '');
}

/** Executes a single DDL statement (CREATE TABLE, ALTER TABLE, CREATE INDEX). */
export async function executeDDL(ddlStatement) {
  try {
    await sql.executeDDL(ddlStatement);
    return { result: true };
  } catch (error) {
    console.error('Forge SQL DDL Error:', sqlErrorSummary(error), 'Statement:', sqlStatementSummary(ddlStatement));
    return {
      result: false,
      error,
    };
  }
}
