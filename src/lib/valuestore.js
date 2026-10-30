import { gzipSync, gunzipSync } from 'zlib';
import { canonical, sha256Hex } from './hash.js';

/**
 * Encode retained field values as va_baseline_value rows and decode them.
 *
 * Preserve every byte of each supplied value. Store content only when the
 * caller has explicitly requested value retention.
 */

/** Encoding tags written into va_baseline_value.encoding. */
export const ENCODING = {
  /** JSON, gzipped, base64'd. The normal case. */
  GZIP_B64: 'GZIP_B64',
  /**
 * Use uncompressed base64 when gzip would make short values larger.
 */
  PLAIN_B64: 'PLAIN_B64'
};

/**
 * Limit each base64 chunk below MEDIUMTEXT's 16 MiB ceiling to bound the size
 * of individual Forge SQL statements.
 */
export const CHUNK_CHARS = 60_000;

/**
 * Encode one value as { encoding, rawBytes, chunks: string[] } split to
 * CHUNK_CHARS. Callers write one row per chunk using its index as seq.
 * Canonical JSON gives structurally identical values identical bytes.
 */
export function encodeValue(value) {
  const json = canonical(value === undefined ? null : value);
  const rawBuffer = Buffer.from(json, 'utf8');
  const rawBytes = rawBuffer.length;

  const gzipped = gzipSync(rawBuffer, { level: 9 });

  // Only take the compressed form if it actually helped. For a 12-byte value
  // the gzip header alone is larger than the payload.
  const useGzip = gzipped.length < rawBuffer.length;
  const encoding = useGzip ? ENCODING.GZIP_B64 : ENCODING.PLAIN_B64;
  const b64 = (useGzip ? gzipped : rawBuffer).toString('base64');

  // Minimize string allocations by avoiding slice copies for single-chunk payloads
  let chunks;
  if (b64.length === 0) {
    chunks = [''];
  } else if (b64.length <= CHUNK_CHARS) {
    chunks = [b64];
  } else {
    chunks = [];
    const len = b64.length;
    for (let i = 0; i < len; i += CHUNK_CHARS) {
      chunks.push(b64.slice(i, i + CHUNK_CHARS));
    }
  }

  return { encoding, rawBytes, chunks };
}

/**
 * Sort chunks by seq and reassemble the original value. Do not depend on
 * caller row order, which could otherwise corrupt the JSON.
 * @param rows [{ seq, encoding, data }] in any order
 */
export function decodeValue(rows) {
  if (!rows || rows.length === 0) return { present: false, value: null };

  const len = rows.length;
  let ordered;
  if (len === 1) {
    ordered = rows;
  } else {
    ordered = [...rows].sort((a, b) => a.seq - b.seq);
  }

  const first = ordered[0];
  const encoding = first.encoding;
  if (!Object.values(ENCODING).includes(encoding)) throw new Error('BASELINE_VALUE_ENCODING');

  if (len === 1) {
    if (first.seq !== 0 && Number(first.seq) !== 0) throw new Error('BASELINE_VALUE_INCOMPLETE');
  } else {
    for (let i = 0; i < len; i++) {
      const r = ordered[i];
      if ((r.seq !== i && Number(r.seq) !== i) || r.encoding !== encoding) {
        throw new Error('BASELINE_VALUE_INCOMPLETE');
      }
    }
  }

  const b64 = len === 1 ? (first.data ?? '') : ordered.map((r) => r.data ?? '').join('');
  if (b64.length === 0) return { present: true, value: null };

  const buffer = Buffer.from(b64, 'base64');
  let json;
  let rawLength;
  if (encoding === ENCODING.GZIP_B64) {
    const decompressed = gunzipSync(buffer);
    rawLength = decompressed.length;
    json = decompressed.toString('utf8');
  } else {
    rawLength = buffer.length;
    json = buffer.toString('utf8');
  }

  if (first.raw_bytes != null && rawLength !== Number(first.raw_bytes)) {
    throw new Error('BASELINE_VALUE_INCOMPLETE');
  }
  return { present: true, value: JSON.parse(json) };
}

/**
 * Summarize values for va_drift.from_repr, to_repr and queue rows within
 * their VARCHAR(512) columns. Full diffs read va_baseline_value and the live
 * issue instead. Return null for unretained values so they cannot be mistaken
 * for fields cleared to an empty string.
 */
export function summarise(value, kind, { maxLength = 200 } = {}) {
  if (value === undefined) return null;
  if (value === null) return '(empty)';

  let text;
  if (kind === 'ADF') {
    text = adfPlainText(value);
  } else if (Array.isArray(value)) {
    text = value.map((v) => shortScalar(v)).join(', ');
  } else if (typeof value === 'object') {
    text = shortScalar(value);
  } else {
    text = String(value);
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '(empty)';
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > maxLength - 40 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

function shortScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return String(v.name ?? v.value ?? v.displayName ?? v.key ?? v.id ?? '');
  return String(v);
}

/**
 * Extract plain text for summaries with a separate local walker. Keep display
 * changes independent of the diff engine's content comparisons.
 */
export function adfPlainText(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;

  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    if (node.type === 'text' && typeof node.text === 'string') { out.push(node.text); return; }
    if (node.type === 'mention') { out.push(node.attrs?.text ?? '@user'); return; }
    if (node.type === 'emoji') { out.push(node.attrs?.text ?? node.attrs?.shortName ?? ''); return; }
    if (node.type === 'media' || node.type === 'mediaSingle' || node.type === 'mediaGroup') {
      out.push('[attachment]');
      return;
    }
    // Unknown or structural node: descend. Never drop a subtree just because
    // this function does not recognise its wrapper.
    walk(node.content);
    if (BLOCKISH.has(node.type)) out.push(' ');
  };
  walk(doc);
  return out.join('');
}

const BLOCKISH = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'rule', 'panel',
  'listItem', 'tableRow', 'mediaSingle', 'mediaGroup'
]);

/**
 * Stable identity for a set of retained values, used to detect that a capture
 * would write exactly what is already stored.
 */
export function valuesHash(values) {
  return sha256Hex(canonical(values ?? {}));
}
