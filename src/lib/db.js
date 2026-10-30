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
 * Slow-query logging threshold in milliseconds.
 *
 * Forge SQL documents SELECT and DML timeouts of 5 and 10 seconds. A 2-second
 * threshold reports a slow SELECT after 40% of its budget. See the "Known
 * bounds" section of docs/PERFORMANCE-CHECKLIST.md.
 */
export const SLOW_QUERY_MS = 2000;

/**
 * Log every query duration and tag those crossing thresholdMs.
 *
 * This alert is a structured log entry, with no outbound delivery. Keep it
 * separate from the 21 CFR 11.300(d) security-alert pipeline: db/alertStore.js
 * calls executeQuery, so sending query alerts through it could recurse.
 * Log collection can filter or alert on the distinct slow-query tag.
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
    // The installed @forge/sql exposes bindParams, not bind. SqlStatement has no
    // .bind() method. Results contain { rows, metadata }, not { rows, meta }.
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
 * Forge SQL uses JSON for parameters and results. BINARY, VARBINARY and BLOB
 * columns return strings. Binding a raw Buffer serializes it as
 * {"type":"Buffer","data":[...]}, which is not a valid VARBINARY value.
 *
 * Base64-encode parameters through toBinaryParam, bind the string and use
 * FROM_BASE64(?) in SQL. Read with TO_BASE64(column) AS column, then decode
 * through fromBinaryColumn.
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
 * Detect errors for columns that a scheduled migration has not added yet.
 *
 * jobs/migrate.js runs every five minutes, not at deployment. New code may run
 * against the previous schema until that trigger fires. executeQuery already
 * returns { result: false } for missing tables; callers also need to tolerate
 * missing columns on existing tables, including va_signature.
 *
 * Match the driver's code when available and otherwise its message, as
 * isDuplicateKey does in db/store.js.
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
