import { createHash } from 'crypto';

/**
 * Deterministic JSON serialisation.
 *
 * The audit chain hashes event payloads. If two runs of the same event could
 * serialise to different bytes, the chain would be unverifiable and every
 * compliance claim resting on it would collapse. So: object keys sorted
 * recursively, no whitespace, and unsupported types rejected loudly rather
 * than coerced silently.
 */
export function canonical(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v) {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(sortDeep);
  const t = typeof v;
  if (t === 'number') {
    // NaN and Infinity serialise to null in JSON, which would make two
    // different events hash identically. Refuse them.
    if (!Number.isFinite(v)) throw new TypeError('non-finite number in audit payload');
    return v;
  }
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'undefined') throw new TypeError('undefined in audit payload');
  if (t === 'bigint') return v.toString();
  if (t === 'object') {
    if (v instanceof Date) throw new TypeError('Date in audit payload; use epoch millis');
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = sortDeep(v[k]);
    }
    return out;
  }
  throw new TypeError(`unserialisable type in audit payload: ${t}`);
}

export function sha256Hex(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest('hex');
}

/** The genesis link. seq 0 has no predecessor. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Hash of one ledger entry. Field order here is part of the on-disk format:
 * changing it invalidates every previously written chain. Do not reorder.
 */
export function entryHash({ seq, prevHash, occurredAt, actorAccountId, eventType, issueId, approvalId, payload }) {
  return sha256Hex(canonical({
    seq,
    prevHash,
    occurredAt,
    actorAccountId,
    eventType,
    issueId: issueId ?? null,
    approvalId: approvalId ?? null,
    payload
  }));
}
