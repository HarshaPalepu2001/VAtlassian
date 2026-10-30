import { normaliseAdf } from '../content.js';
import { canonical } from '../hash.js';
import { dateText } from './structure.js';

/**
 * Extract ADF blocks for adf.js. Each block includes inline text, formatting,
 * container context and a signature over its normalised bytes and context.
 */

/**
 * Descend through unlisted node types to find blocks so new ADF containers
 * do not hide their text from the diff.
 */
const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'rule', 'panel',
  'listItem', 'taskItem', 'decisionItem', 'mediaSingle', 'mediaGroup',
  'tableRow', 'expand', 'nestedExpand'
]);

/**
 * Separate cells in a row's flat text for LCS, similarity and whitespace
 * comparison. Keep the cells separately for rendering. The separator should
 * not occur in ordinary cell text.
 */
const CELL_SEPARATOR = ' | ';

/**
 * Flatten ADF into ordered leaf blocks with text, formatting and paths.
 * Compare nested paragraphs individually instead of treating their enclosing
 * list, panel or blockquote as one block.
 */
export function flatten(doc, options = {}) {
  const blocks = [];
  if (doc == null) return blocks;
  if (typeof doc === 'string') {
    return [withSignature({ type: 'paragraph', text: doc, marks: [], path: [0], context: [], node: null })];
  }

  // context records each enclosing container and its attrs for comparison.
  // Keep the older ancestry list for callers that read block types.
  const walk = (node, path, ancestry, context) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, i], ancestry, context));
      return;
    }

    // Keep each table row as one block with separate cells. Descending to cell
    // paragraphs would lose the table structure when rendering changes.
    if (node.type === 'tableRow') {
      blocks.push(withSignature({ ...tableRow(node, path, ancestry, options), context }));
      return;
    }

    const isBlock = BLOCK_TYPES.has(node.type);
    // Treat a node with only inline descendants as a block, including unknown
    // node types. Checking only immediate children can drop nested text.
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
 * Check all descendants for recognized blocks. A shallow search can combine
 * nested lists into one block and hide which bullet changed.
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
 * Compare formatting separately from text. Sort and deduplicate marks so
 * reordering them does not count as a change.
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
  // Include block-level marks, such as paragraph alignment and indentation.
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
