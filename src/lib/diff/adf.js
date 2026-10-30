import { normaliseAdf } from '../content.js';
import { canonical } from '../hash.js';
import { flatten } from './blocks.js';
import { describeStructure } from './structure.js';
import { diffText, similarity, isWhitespaceOnly, coalesce, OP } from './text.js';

/**
 * Compare Atlassian Document Format using the same normaliseAdf function
 * as content hashing.
 *
 * Flatten documents into blocks, find unchanged signatures with LCS and pair
 * remaining blocks by similarity. Detect moves, then compare words, marks
 * and structure separately. Formatting-only changes can be cosmetic while
 * structural changes, such as checkbox state or panel type, remain material.
 *
 * Exact block equality includes normalised bytes and the container chain.
 * If document bytes differ after all blocks compare equal, report a structural
 * change. The diff must not hide a change that content hashing detects.
 */

// The block layer lives in blocks.js; re-exported so callers keep one import.
export { flatten, inlineText, markSignature } from './blocks.js';

export const BLOCK_OP = {
  EQUAL: 'equal',
  INSERT: 'insert',
  DELETE: 'delete',
  MODIFIED: 'modified',
  MOVE: 'move',
  /** Same text, different formatting. Never queues a review on its own. */
  MARK_ONLY: 'markOnly',
  /**
 * Same text with changed node type, attrs or containers. structureChange
 * names each difference. These changes are material, including checkbox state
 * and warning-to-info changes.
 */
  STRUCTURE: 'structure'
};

/** Similarity above which a delete/insert pair is really one modified block. */
export const PAIR_THRESHOLD = 0.5;

/** What two blocks are compared on for exact equality: their bytes and containers. */
function signature(block) {
  return block.sig;
}

/**
 * Diff two ADF documents.
 *
 * @returns {
 *   blocks: Array<{ op, before?, after?, ops?, markChange?, from?, to? }>,
 *   semanticChange: boolean,   // false ⇒ formatting/whitespace only
 *   magnitude: number
 * }
 */
export function diffAdf(before, after, options = {}) {
  const a = flatten(before, options);
  const b = flatten(after, options);

  const sigA = a.map(signature);
  const sigB = b.map(signature);
  const matched = lcsMatch(sigA, sigB);

  // Walk both sides together, emitting equal blocks from the LCS and
  // collecting the gaps between them for pairing.
  const result = [];
  let i = 0;
  let j = 0;
  const pendingDeletes = [];
  const pendingInserts = [];

  const flushGap = () => {
    if (pendingDeletes.length === 0 && pendingInserts.length === 0) return;
    result.push(...pairGap(pendingDeletes.splice(0), pendingInserts.splice(0)));
  };

  for (const [ai, bi] of matched) {
    while (i < ai) pendingDeletes.push(a[i++]);
    while (j < bi) pendingInserts.push(b[j++]);
    flushGap();
    result.push({ op: BLOCK_OP.EQUAL, before: a[i], after: b[j] });
    i++; j++;
  }
  while (i < a.length) pendingDeletes.push(a[i++]);
  while (j < b.length) pendingInserts.push(b[j++]);
  flushGap();

  const withMoves = detectMoves(result);

  // Different document bytes may come from an empty container with no blocks.
  // Report those as structural changes even if every block compared equal.
  if (withMoves.every((blk) => blk.op === BLOCK_OP.EQUAL)
      && canonical(normaliseAdf(before)) !== canonical(normaliseAdf(after))) {
    withMoves.push({ op: BLOCK_OP.STRUCTURE, structureChange: [{ kind: 'document', text: 'Document structure changed' }] });
  }

  return {
    blocks: withMoves,
    semanticChange: computeSemanticChange(withMoves, a, b),
    magnitude: computeMagnitude(withMoves)
  };
}

/**
 * Find identical block pairs by longest common subsequence.
 * For large documents, use positional matching to bound computation.
 */
function lcsMatch(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > 1_000_000) {
    const pairs = [];
    for (let k = 0; k < Math.min(n, m); k++) if (a[k] === b[k]) pairs.push([k, k]);
    return pairs;
  }

  const table = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = a[i] === b[j]
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Pair unmatched deletes with the most similar remaining insert above the
 * similarity threshold. Use greedy matching for these small gaps.
 */
function pairGap(deletes, inserts) {
  const out = [];
  const takenInserts = new Set();

  // Pair a single delete and insert as one edit without a similarity threshold.
  // Unrelated strings still render as complete deletion and insertion. Reserve
  // the threshold for ambiguous many-to-many gaps.
  if (deletes.length === 1 && inserts.length === 1) {
    const [del] = deletes;
    const [ins] = inserts;
    return [del.text === ins.text ? sameText(del, ins) : modified(del, ins)];
  }

  for (const del of deletes) {
    let best = -1;
    let bestScore = PAIR_THRESHOLD;
    inserts.forEach((ins, idx) => {
      if (takenInserts.has(idx)) return;
      const score = similarity(del.text, ins.text);
      if (score > bestScore) { bestScore = score; best = idx; }
    });

    if (best === -1) {
      out.push({ op: BLOCK_OP.DELETE, before: del });
      continue;
    }

    const ins = inserts[best];
    takenInserts.add(best);

    out.push(del.text === ins.text ? sameText(del, ins) : modified(del, ins));
  }

  inserts.forEach((ins, idx) => {
    if (!takenInserts.has(idx)) out.push({ op: BLOCK_OP.INSERT, after: ins });
  });

  return out;
}

/** One block rewritten into another, with a cell breakdown when both are rows. */
function modified(del, ins) {
  const block = {
    op: BLOCK_OP.MODIFIED,
    before: del,
    after: ins,
    ops: coalesce(diffText(del.text, ins.text)),
    markChange: sameMarks(del.marks, ins.marks) ? null : { from: del.marks, to: ins.marks }
  };
  const structure = describeStructure(del, ins);
  if (structure.length) block.structureChange = structure;
  if (del.cells && ins.cells) block.cells = diffCells(del.cells, ins.cells);
  return block;
}

/**
 * Classify mark-only differences as formatting so materiality can use
 * COSMETIC. Report all other byte differences as structure, even when no more
 * specific description is available.
 */
function sameText(del, ins) {
  const structure = describeStructure(del, ins);
  const markChange = sameMarks(del.marks, ins.marks) ? null : { from: del.marks, to: ins.marks };
  if (structure.length === 0 && markChange) {
    return { op: BLOCK_OP.MARK_ONLY, before: del, after: ins, markChange };
  }
  return {
    op: BLOCK_OP.STRUCTURE,
    before: del,
    after: ins,
    markChange,
    structureChange: structure.length ? structure : [{ kind: 'other', text: 'Structure changed' }]
  };
}

/**
 * Compare table cells by position to keep changes in their original column.
 * Report added or removed columns without matching similar text across columns.
 */
function diffCells(before, after) {
  const out = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const a = before[i];
    const b = after[i];
    if (!b) {
      out.push({ op: BLOCK_OP.DELETE, before: a.text, after: null, header: a.header, ops: [] });
      continue;
    }
    if (!a) {
      out.push({ op: BLOCK_OP.INSERT, before: null, after: b.text, header: b.header, ops: [] });
      continue;
    }
    if (a.text === b.text) {
      out.push({ op: BLOCK_OP.EQUAL, before: a.text, after: b.text, header: b.header, ops: [] });
      continue;
    }
    out.push({
      op: BLOCK_OP.MODIFIED, before: a.text, after: b.text, header: b.header,
      ops: coalesce(diffText(a.text, b.text))
    });
  }
  return out;
}

function sameMarks(a, b) {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}


/**
 * Recognize identical content deleted in one position and inserted in
 * another as a move.
 */
function detectMoves(blocks) {
  const deletes = new Map();
  blocks.forEach((b, idx) => {
    if (b.op === BLOCK_OP.DELETE) {
      const key = signature(b.before);
      if (!deletes.has(key)) deletes.set(key, []);
      deletes.get(key).push(idx);
    }
  });
  if (deletes.size === 0) return blocks;

  const consumed = new Set();
  const out = blocks.map((b) => ({ ...b }));

  out.forEach((b, idx) => {
    if (b.op !== BLOCK_OP.INSERT) return;
    const key = signature(b.after);
    const candidates = deletes.get(key);
    if (!candidates || candidates.length === 0) return;

    const from = candidates.shift();
    consumed.add(from);
    out[idx] = {
      op: BLOCK_OP.MOVE,
      before: out[from].before,
      after: b.after,
      fromIndex: from,
      toIndex: idx
    };
  });

  return out.filter((_, idx) => !consumed.has(idx));
}

/**
 * Return false for formatting, whitespace and pure moves. materiality.js
 * uses this to classify description edits as COSMETIC. Moving acceptance
 * criteria preserves their text. A customer's configured field materiality
 * can override this classification.
 */
function computeSemanticChange(blocks, aBlocks, bBlocks) {
  // Structural changes are semantic even when text is unchanged. Text-only
  // whitespace comparison cannot detect checkbox or panel-type changes.
  if (blocks.some((b) => b.op === BLOCK_OP.STRUCTURE || (b.structureChange?.length ?? 0) > 0)) return true;

  const changed = blocks.some((b) =>
    b.op === BLOCK_OP.INSERT || b.op === BLOCK_OP.DELETE || b.op === BLOCK_OP.MODIFIED
  );
  if (!changed) return false;

  // A similarity-paired modified block may differ only in whitespace.
  const allText = (list) => list.map((x) => x.text).join('\n');
  return !isWhitespaceOnly(allText(aBlocks), allText(bBlocks));
}

function computeMagnitude(blocks) {
  let changed = 0;
  let total = 0;
  for (const b of blocks) {
    const beforeLen = b.before?.text?.length ?? 0;
    const afterLen = b.after?.text?.length ?? 0;
    total += Math.max(beforeLen, afterLen);
    if (b.op === BLOCK_OP.INSERT) changed += afterLen;
    else if (b.op === BLOCK_OP.DELETE) changed += beforeLen;
    else if (b.op === BLOCK_OP.STRUCTURE) changed += Math.max(beforeLen, afterLen);
    else if (b.op === BLOCK_OP.MODIFIED) {
      for (const op of b.ops ?? []) if (op.op !== OP.EQUAL) changed += op.text.length;
    }
  }
  return total === 0 ? 0 : Math.min(1, changed / total);
}

/**
 * A one-line description of what happened to a document, for the queue row and
 * the AI payload.
 */
export function describeAdfDiff(result) {
  const counts = { added: 0, removed: 0, edited: 0, moved: 0, reformatted: 0, restructured: 0 };
  for (const b of result.blocks) {
    if (b.op === BLOCK_OP.INSERT) counts.added++;
    else if (b.op === BLOCK_OP.DELETE) counts.removed++;
    else if (b.op === BLOCK_OP.MODIFIED) counts.edited++;
    else if (b.op === BLOCK_OP.MOVE) counts.moved++;
    else if (b.op === BLOCK_OP.MARK_ONLY) counts.reformatted++;
    else if (b.op === BLOCK_OP.STRUCTURE) counts.restructured++;
  }

  const parts = [];
  if (counts.edited) parts.push(`${counts.edited} paragraph${counts.edited === 1 ? '' : 's'} edited`);
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  if (counts.moved) parts.push(`${counts.moved} moved`);
  if (counts.reformatted) parts.push(`${counts.reformatted} reformatted`);
  if (counts.restructured) parts.push(`${counts.restructured} restructured`);
  return parts.length > 0 ? parts.join(', ') : 'no visible change';
}
