import { normaliseAdf } from '../content.js';
import { canonical } from '../hash.js';
import { flatten } from './blocks.js';
import { describeStructure } from './structure.js';
import { diffText, similarity, isWhitespaceOnly, coalesce, OP } from './text.js';

/**
 * Atlassian Document Format diffing.
 *
 * The showpiece, and the reason a reviewer can look at a changed description
 * and understand it in seconds rather than re-reading two paragraphs
 * side by side hunting for the difference.
 *
 * THE ALGORITHM, and why each stage earns its place:
 *
 *   1. NORMALISE using content.js's own normaliseAdf, so the diff and the hash
 *      can never disagree about what a document is. Sharing that function is
 *      not a convenience — if the differ stripped a key the hasher kept, a
 *      field could report "changed" with an empty diff, which reads as a bug in
 *      the app rather than as an edit.
 *   2. FLATTEN to blocks. People edit documents a paragraph at a time.
 *   3. LCS over block signatures — the unchanged blocks, found exactly.
 *   4. PAIR the leftovers by similarity. Without this, editing one sentence
 *      renders as "paragraph deleted, paragraph inserted": true, and useless.
 *   5. DETECT MOVES. Reordering a list is one fact, not twenty.
 *   6. INLINE DIFF inside modified blocks, at word granularity.
 *   7. MARK PASS, separately, so "this sentence became a link" is a formatting
 *      change and not a delete-plus-insert of identical text. This is what
 *      makes cosmetic suppression possible for rich text at all.
 *   8. STRUCTURE PASS. Everything a block is besides its words and marks — its
 *      own attrs, the containers it sits in and theirs, the inline nodes that
 *      are not text — named in a sentence a reviewer can read.
 *
 * THE DIFF SEES EVERY BYTE THE HASH SEES. content.js hashes the whole
 * normalised document, so a panel turned from warning to info, a checkbox
 * ticked or a checklist item turned into a plain sentence is drift. This file
 * used to compare a block by its type, text and mark NAMES only, so each of
 * those compared EQUAL or rendered with nothing to say what had changed — and a
 * field whose blocks all compared equal was reported unchanged, which the
 * restore planner skips. A block is now equal only when its normalised bytes
 * AND its container chain are, and diffAdf() refuses to call two documents the
 * same when their bytes are not.
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
   * Same text, different structure: a type, an attr, or the containers around
   * it. `structureChange` says what, one sentence per difference. Material —
   * a checkbox ticked or a warning downgraded to info changes what was agreed.
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

  // THE BACKSTOP. Every difference inside a block is caught above; one that
  // lives only in a container with no text beneath it would still compare
  // every block equal. Two documents whose hashed bytes differ are never
  // reported as the same — "changed" with a vague note beats "unchanged".
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
 * Index pairs of identical blocks, longest common subsequence.
 *
 * Same complexity guard as the text differ: enormous documents fall back to a
 * positional match, which is cruder but instant. A panel that renders a rough
 * diff beats one that times out.
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
 * Turn a run of unmatched deletes and inserts into the smallest honest set of
 * operations.
 *
 * Greedy best-match pairing: each deleted block takes the most similar
 * remaining inserted block, provided they are similar enough to be the same
 * block edited rather than two different blocks. Greedy rather than optimal
 * because the gaps are small (a handful of blocks), and an optimal assignment
 * would cost more to explain than it would ever buy.
 */
function pairGap(deletes, inserts) {
  const out = [];
  const takenInserts = new Set();

  // ONE OUT, ONE IN IS ALWAYS AN EDIT.
  //
  // A gap containing exactly one deleted block and one inserted block is a
  // paragraph somebody rewrote, essentially always — and treating it as one is
  // safe even when the two are unrelated, because the inline diff of two
  // dissimilar strings degenerates to delete-everything plus insert-everything,
  // which renders identically to the alternative. Similarity thresholds are for
  // the ambiguous many-to-many case; insisting on one here means a short
  // paragraph like "First." becoming "First, now edited." scores below the
  // threshold and is reported as a deletion and an unrelated insertion.
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
 * Two blocks with the same words that are not the same bytes.
 *
 * Marks alone is formatting — its own op, so materiality can demote it to
 * COSMETIC instead of paging a reviewer because somebody bolded a word.
 * Anything else is structure, and says what. There is no third outcome: a pair
 * that differs in a way nothing here can name is still reported, as structure,
 * because the only alternative is rendering a changed block with nothing to
 * say about it.
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
 * Cells, compared BY POSITION.
 *
 * A table's meaning is positional — the third cell is the Type column whatever
 * it says — so a reviewer needs to know which column moved, not which text is
 * similar to which other text. Pairing by similarity instead would happily
 * report the Type column's "Gas Giant" as an edit of the Diameter column.
 *
 * A row that gained or lost a column therefore reports that cell as added or
 * removed and leaves every other cell where it is.
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
 * A block deleted here and inserted there, with identical content, is a MOVE.
 *
 * Worth the extra pass because reordering a checklist is one thing a person
 * did, and rendering it as ten deletions and ten insertions buries the two
 * blocks that genuinely changed underneath twenty that did not.
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
 * Did anything change that a reader would notice?
 *
 * False when every difference is formatting, whitespace or a pure move. This is
 * the value materiality.js reads to decide whether a description edit is
 * COSMETIC, and therefore whether it belongs in a reviewer's queue at all.
 *
 * A MOVE counts as cosmetic here on purpose, and it is a judgement call worth
 * naming: reordering the acceptance criteria does not change what they say. If
 * a customer disagrees, they raise the field's configured materiality, which
 * overrides this.
 */
function computeSemanticChange(blocks, aBlocks, bBlocks) {
  // Structure is meaning. The words did not move, but a ticked box, a lost
  // checkbox or a warning downgraded to info changes what a reader is told —
  // and the whitespace test below, which compares text alone, would call it
  // nothing at all.
  if (blocks.some((b) => b.op === BLOCK_OP.STRUCTURE || (b.structureChange?.length ?? 0) > 0)) return true;

  const changed = blocks.some((b) =>
    b.op === BLOCK_OP.INSERT || b.op === BLOCK_OP.DELETE || b.op === BLOCK_OP.MODIFIED
  );
  if (!changed) return false;

  // A "modified" block whose only difference is whitespace is still cosmetic —
  // the pairing stage matched it on similarity, not on identity.
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
