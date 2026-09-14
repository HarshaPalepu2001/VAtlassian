import { gzipSync, gunzipSync } from 'zlib';
import { canonical, sha256Hex } from './hash.js';

/**
 * The value codec: how a retained field value becomes rows in
 * va_baseline_value, and how it comes back.
 *
 * This module is where the app stops storing digests and starts storing
 * contents, which is the whole compliance boundary. Everything here is
 * therefore conservative about two things — never losing a byte, and never
 * storing a byte it was not told to store.
 */

/** Encoding tags written into va_baseline_value.encoding. */
export const ENCODING = {
  /** JSON, gzipped, base64'd. The normal case. */
  GZIP_B64: 'GZIP_B64',
  /**
   * JSON, base64'd, not compressed. Used when gzip made the payload BIGGER,
   * which happens for very short values where the gzip header dominates.
   * Storing the larger form "for consistency" would be a waste on exactly the
   * fields there are most of.
   */
  PLAIN_B64: 'PLAIN_B64'
};

/**
 * Base64 characters per chunk row.
 *
 * Chosen well below MEDIUMTEXT's 16 MiB ceiling because the real limit is not
 * the column, it is the size of a single Forge SQL statement — a bound that is
 * not published as a number and that we should not discover in production on a
 * customer's largest description. 180k base64 chars is ~135 KiB of gzipped
 * data, which for ADF is on the order of a megabyte of source document, so the
 * overwhelming majority of fields are a single row and chunking costs nothing.
 */
export const CHUNK_CHARS = 60_000;

/**
 * Encode one field value into chunk payloads.
 *
 * Returns { encoding, rawBytes, chunks: string[] } where `chunks` is already
 * split to CHUNK_CHARS. The caller writes one row per chunk with its index as
 * `seq`.
 *
 * `canonical` rather than JSON.stringify: two structurally identical values
 * must produce identical bytes, so that a re-capture of unchanged content
 * writes an identical row and the storage-accounting figures on the retention
 * screen do not wobble for no reason.
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

  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) {
    chunks.push(b64.slice(i, i + CHUNK_CHARS));
  }
  // A genuinely empty payload still needs one row, so that "no rows" can mean
  // "this field was never retained" rather than "this field was retained and
  // happened to be empty". Those are different facts and the reject dialog
  // says different things about them.
  if (chunks.length === 0) chunks.push('');

  return { encoding, rawBytes, chunks };
}

/**
 * Reassemble chunk rows into the original value.
 *
 * @param rows [{ seq, encoding, data }] — ANY order; sorted here.
 *
 * Sorting rather than trusting the caller's ORDER BY is deliberate: a
 * mis-ordered reassembly produces corrupt JSON, which throws, which surfaces as
 * "this baseline is unreadable" — a scary and misleading message for what would
 * be a missing ORDER BY clause. One sort removes the whole class.
 */
export function decodeValue(rows) {
  if (!rows || rows.length === 0) return { present: false, value: null };

  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const encoding = ordered[0].encoding;
  if (!Object.values(ENCODING).includes(encoding)) throw new Error('BASELINE_VALUE_ENCODING');
  if (ordered.some((row, index) => Number(row.seq) !== index || row.encoding !== encoding)) {
    throw new Error('BASELINE_VALUE_INCOMPLETE');
  }
  const b64 = ordered.map((r) => r.data ?? '').join('');
  if (b64.length === 0) return { present: true, value: null };

  const buffer = Buffer.from(b64, 'base64');
  const json = encoding === ENCODING.GZIP_B64
    ? gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8');

  if (ordered[0].raw_bytes != null && Buffer.byteLength(json, 'utf8') !== Number(ordered[0].raw_bytes)) {
    throw new Error('BASELINE_VALUE_INCOMPLETE');
  }
  return { present: true, value: JSON.parse(json) };
}

/**
 * A short, human-readable rendering of a value, for va_drift.from_repr /
 * to_repr and for queue rows.
 *
 * These columns are VARCHAR(512) and this is what keeps them inside it. The
 * point is that a queue row can say "Priority: High -> Highest" without reading
 * the value store at all; the full before/after for the diff always comes from
 * va_baseline_value and the live issue, never from here.
 *
 * Returns null for a value that was never retained, and the panel renders that
 * as "changed (contents not retained)" rather than as an empty string — an
 * empty string would read as "this field was cleared", which is a completely
 * different and much more alarming claim.
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
 * ADF to plain text, for summaries only.
 *
 * Deliberately a local, minimal walker rather than an import of the diff
 * engine's ADF handling: a function that feeds a one-line summary must never
 * share code with one that decides whether content changed, or a display tweak
 * becomes a correctness change.
 */
export function adfPlainText(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;

  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
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
