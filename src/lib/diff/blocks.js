import { normaliseAdf } from '../content.js';
import { canonical } from '../hash.js';
import { dateText } from './structure.js';

/**
 * WHAT A BLOCK IS — the layer adf.js diffs over.
 *
 * Split from adf.js so that file can stay about pairing. Everything here
 * answers one question: given an ADF document, what are its blocks, and what
 * exactly is each one? Its words (inlineText), its formatting (markSignature),
 * the containers it sits in (context), and its identity (sig): the normalised
 * bytes plus that container chain, which is what makes "equal" mean equal.
 */

/**
 * Blocks are the unit a person edits. Anything not listed is descended into
 * rather than treated as a block, so a document using a node type that did not
 * exist when this was written still diffs its text instead of rendering as one
 * opaque lump.
 */
const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'rule', 'panel',
  'listItem', 'taskItem', 'decisionItem', 'mediaSingle', 'mediaGroup',
  'tableRow', 'expand', 'nestedExpand'
]);

/**
 * What separates two cells in a row's flat text.
 *
 * The row's `text` exists so that the LCS, the similarity pairing and the
 * whitespace check can treat a row like any other block. The cells are carried
 * alongside it and are what the panel actually draws, so this only has to be
 * something a person would not type inside a cell.
 */
const CELL_SEPARATOR = ' | ';

/**
 * Flatten an ADF document into an ordered list of blocks.
 *
 * Each block carries its plain text, its mark signature and a path, so the
 * renderer can point at the exact node and the differ can compare like with
 * like. Nested structures (a list inside a panel inside a blockquote) flatten
 * to their leaf blocks: a person editing a bullet expects the bullet to be the
 * thing that changed, not the panel three levels up.
 */
export function flatten(doc, options = {}) {
  const blocks = [];
  if (doc == null) return blocks;
  if (typeof doc === 'string') {
    return [withSignature({ type: 'paragraph', text: doc, marks: [], path: [0], context: [], node: null })];
  }

  // `context` is every container between the document and the block — lists,
  // panels, quotes, tables, expands — each with its attrs. `ancestry` (block
  // types only) predates it and is kept for callers that read it; `context` is
  // what the comparison uses, because a bulleted list renumbered as an ordered
  // list, or a panel changed from warning to info, changes nothing else.
  const walk = (node, path, ancestry, context) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, i], ancestry, context));
      return;
    }

    // A TABLE ROW IS THE BLOCK, AND IT KEEPS ITS CELLS.
    //
    // Every cell holds a paragraph, so the ordinary container rule would
    // descend past the row and emit one block per cell. A table added after
    // approval then rendered as a column of green lines — "Planet",
    // "Diameter (km)", "Type", "Jupiter", … — which is every value the table
    // contains and none of the structure that makes them mean anything.
    //
    // Stopping at the row keeps one edited cell as one changed row, and lets
    // the panel put the rows back together as a table.
    if (node.type === 'tableRow') {
      blocks.push(withSignature({ ...tableRow(node, path, ancestry, options), context }));
      return;
    }

    const isBlock = BLOCK_TYPES.has(node.type);
    // DEEP, not shallow. A node whose only descendants are inline content has
    // no block inside it to descend to, so it IS the block — including one of a
    // type this file has never heard of. A shallow check drops such a node's
    // text entirely, which is the failure that matters: a reviewer seeing LESS
    // than the record contains is far worse than one seeing an odd wrapper.
    const container = hasBlockDescendant(node);

    // A blockquote whose children are paragraphs is a container, not a block.
    // Emitting both would double-count its text in every similarity score.
    if ((isBlock || node.type !== 'doc') && !container) {
      blocks.push(withSignature({
        type: node.type,
        text: inlineText(node, options),
        marks: markSignature(node),
        attrs: node.attrs ?? null,
        path,
        ancestry: [...ancestry],
        context,
        node
      }));
      return;
    }

    walk(node.content, [...path, 'content'],
      isBlock ? [...ancestry, node.type] : ancestry,
      node.type === 'doc' ? context : [...context, containerOf(node)]);
  };

  walk(normaliseAdf(doc), [], [], []);
  return blocks;
}

/** A container as the comparison sees it: its type and attrs, never its content. */
function containerOf(node) {
  return node.attrs ? { type: node.type, attrs: node.attrs } : { type: node.type };
}

/**
 * The exact identity of a block: its normalised bytes plus the containers it
 * sits in. Normalised already (flatten walks normaliseAdf's output), so the
 * only things that do not count are the ones content.js does not hash either.
 */
function withSignature(block) {
  // Not enumerable: the block goes to the panel, which already carries `node`
  // and has no use for a second, serialised copy of it.
  Object.defineProperty(block, 'sig', {
    value: canonical({ c: block.context ?? [], n: block.node ?? { text: block.text } })
  });
  return block;
}

/**
 * One row, with its cells kept separate.
 *
 * `tableId` is the path of the table the row sits in, so consecutive rows of
 * one table can be grouped back into one rendered table and two adjacent
 * tables are never merged into one.
 */
function tableRow(node, path, ancestry, options = {}) {
  const cells = (node.content ?? []).map((c) => ({
    text: inlineText(c, options),
    header: c?.type === 'tableHeader',
    colspan: Number(c?.attrs?.colspan ?? 1),
    rowspan: Number(c?.attrs?.rowspan ?? 1)
  }));
  return {
    type: 'tableRow',
    text: cells.map((c) => c.text).join(CELL_SEPARATOR),
    cells,
    // The row's own path minus its index and the `content` key holding it.
    tableId: path.slice(0, -2).join('.') || 'table',
    marks: markSignature(node),
    attrs: node.attrs ?? null,
    path,
    ancestry: [...ancestry],
    node
  };
}

/**
 * Does this node contain a recognised block anywhere beneath it?
 *
 * Deep rather than shallow because ADF nests freely — a panel containing a
 * bullet list containing paragraphs has no block among its immediate children,
 * and a shallow check would emit the whole panel as one block, burying which
 * bullet actually changed.
 */
function hasBlockDescendant(node) {
  if (!node || typeof node !== 'object') return false;
  const content = node.content;
  if (!Array.isArray(content)) return false;
  for (const child of content) {
    if (!child || typeof child !== 'object') continue;
    if (BLOCK_TYPES.has(child.type)) return true;
    if (hasBlockDescendant(child)) return true;
  }
  return false;
}

/** All text inside a node, with placeholders for things that are not text. */
export function inlineText(node, options = {}) {
  const mediaMap = options?.mediaMap;
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'text') { out.push(n.text ?? ''); return; }
    if (n.type === 'mention') { out.push(n.attrs?.text ?? '@user'); return; }
    if (n.type === 'emoji') { out.push(n.attrs?.text ?? n.attrs?.shortName ?? ''); return; }
    if (n.type === 'inlineCard' || n.type === 'blockCard') { out.push(n.attrs?.url ?? '[link]'); return; }
    if (n.type === 'hardBreak') { out.push('\n'); return; }
    if (n.type === 'media' || n.type === 'mediaInline') {
      const id = n.attrs?.id ? String(n.attrs.id) : '';
      const name = (mediaMap?.get?.(id) ?? mediaMap?.[id]) ?? n.attrs?.name ?? n.attrs?.alt;
      if (name) {
        out.push(`[attachment: ${name}]`);
      } else if (id) {
        out.push(`[attachment ${id}]`);
      } else {
        out.push('[attachment]');
      }
      return;
    }
    // Lozenges and dates carry their words in attrs. Read as containers they
    // contributed nothing, so a status changed from "ON TRACK" to "AT RISK", or
    // a date moved a month, left the paragraph's text exactly as it was.
    if (n.type === 'status') { out.push(`[${n.attrs?.text ?? ''}]`); return; }
    if (n.type === 'date') { out.push(dateText(n.attrs?.timestamp)); return; }
    if (n.type === 'placeholder') { out.push(n.attrs?.text ?? ''); return; }
    walk(n.content);
  };
  walk(node.content ?? node);
  return out.join('');
}

/**
 * A stable description of the formatting inside a block.
 *
 * Sorted and de-duplicated, so reordering `[bold, link]` to `[link, bold]` —
 * which Jira does freely — is not a change. Comparing these separately from the
 * text is what lets the differ say "same words, now bold" instead of reporting
 * the sentence as rewritten.
 */
export function markSignature(node) {
  const marks = new Set();
  const add = (n) => { for (const m of n?.marks ?? []) marks.add(markName(m)); };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    add(n);
    walk(n.content);
  };
  // The block's OWN marks too — alignment and indentation sit on the paragraph
  // or heading, not on its text, and were never looked at.
  if (node && !Array.isArray(node) && node.content) add(node);
  walk(node?.content ?? node);
  return [...marks].sort();
}

/**
 * A mark with the attrs that make it what it is. `textColor` alone said a word
 * was coloured; `textColor:#ff5630` says which colour, so red turned green is a
 * change the reviewer can see.
 */
function markName(mark) {
  if (mark.type === 'link') return `link:${mark.attrs?.href ?? ''}`;
  const attrs = Object.entries(mark.attrs ?? {})
    .filter(([key]) => key !== 'localId')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, value]) => (value !== null && typeof value === 'object' ? canonical(value) : String(value)));
  return attrs.length ? `${mark.type}:${attrs.join(',')}` : mark.type;
}
