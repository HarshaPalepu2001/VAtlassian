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
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') {
    // NaN and Infinity serialise to null in JSON, which would make two
    // different events hash identically. Refuse them.
    if (!Number.isFinite(v)) throw new TypeError('non-finite number in audit payload');
    return v;
  }
  if (Array.isArray(v)) {
    const len = v.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = sortDeep(v[i]);
    return out;
  }
  if (t === 'undefined') throw new TypeError('undefined in audit payload');
  if (t === 'bigint') return v.toString();
  if (t === 'object') {
    if (v instanceof Date) throw new TypeError('Date in audit payload; use epoch millis');
    const keys = Object.keys(v);
    const keyLen = keys.length;
    if (keyLen === 0) return {};
    if (keyLen === 1) {
      const k = keys[0];
      const val = v[k];
      if (val === undefined) return {};
      return { [k]: sortDeep(val) };
    }
    keys.sort();
    const out = {};
    for (let i = 0; i < keyLen; i++) {
      const k = keys[i];
      const val = v[k];
      if (val === undefined) continue;
      out[k] = sortDeep(val);
    }
    return out;
  }
  throw new TypeError(`unserialisable type in audit payload: ${t}`);
}

export function sha256Hex(first, ...rest) {
  const h = createHash('sha256');
  if (typeof first === 'string') {
    h.update(first, 'utf8');
  } else if (first != null) {
    h.update(first);
  }
  const len = rest.length;
  if (len === 0) {
    return h.digest('hex');
  }
  // Loop unrolling for multi-part hashing (unrolled 4x to minimize branch overhead)
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const p0 = rest[i], p1 = rest[i + 1], p2 = rest[i + 2], p3 = rest[i + 3];
    if (typeof p0 === 'string') h.update(p0, 'utf8'); else if (p0 != null) h.update(p0);
    if (typeof p1 === 'string') h.update(p1, 'utf8'); else if (p1 != null) h.update(p1);
    if (typeof p2 === 'string') h.update(p2, 'utf8'); else if (p2 != null) h.update(p2);
    if (typeof p3 === 'string') h.update(p3, 'utf8'); else if (p3 != null) h.update(p3);
  }
  for (; i < len; i++) {
    const p = rest[i];
    if (typeof p === 'string') h.update(p, 'utf8'); else if (p != null) h.update(p);
  }
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
