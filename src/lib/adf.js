/**
 * Atlassian Document Format -> plain text, for DISPLAY ONLY.
 *
 * WHY NOT AdfRenderer. @forge/react does export an AdfRenderer component, and
 * on a roomy surface it is the right choice. This text runs inside Jira's
 * transition dialog, which is a narrow modal that already has to carry a
 * statement of meaning, a status change and a code box; a full renderer there
 * costs layout we do not have and pulls a full editor bundle into a component
 * whose job is to be fast enough that the signer does not close the dialog.
 *
 * WHY THIS IS NOT lib/content.js. content.js normalises ADF for HASHING —
 * every byte of it is part of the compliance record, and changing how it
 * walks a document would change every content hash ever computed. This
 * function is cosmetic: it feeds a paragraph of context to a human who is
 * about to sign. Sharing code between them would couple a display tweak to
 * the integrity of the audit trail. They are deliberately separate, and this
 * file must never be imported by anything that hashes.
 *
 * Unknown node types degrade to their children rather than being dropped, so
 * a document using a node type that did not exist when this was written still
 * shows its text instead of silently rendering as blank. A signer seeing
 * LESS than the record contains is the failure that matters here.
 */

/** Node types that are not text and should be announced, not omitted. */
const PLACEHOLDERS = {
  mediaSingle: '[attachment]',
  mediaGroup: '[attachment]',
  media: '[attachment]',
  rule: '---',
  codeBlock: null, // children are text; keep them
  table: null
};

/** Node types after which a line break is meaningful. */
const BLOCK_NODES = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'rule', 'panel',
  'listItem', 'tableRow', 'mediaSingle', 'mediaGroup'
]);

/**
 * One line break between blocks, never two. Nested blocks (a listItem whose
 * child is a paragraph; a blockquote wrapping paragraphs) would otherwise
 * each contribute their own break and put a blank line between every list
 * item. In a transition dialog that vertical space is the difference between
 * the description being visible and the signer having to scroll to read what
 * they are signing.
 */
function pushBreak(out) {
  if (out.length > 0 && out[out.length - 1] !== '\n') out.push('\n');
}

function walk(node, out) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }

  const type = node.type;

  if (type === 'text') {
    if (typeof node.text === 'string') out.push(node.text);
    return;
  }

  // Mentions carry their display name in attrs.text, usually prefixed with '@'.
  if (type === 'mention') {
    const text = node.attrs?.text;
    if (typeof text === 'string' && text.length > 0) out.push(text);
    return;
  }

  if (type === 'emoji') {
    const text = node.attrs?.text ?? node.attrs?.shortName;
    if (typeof text === 'string') out.push(text);
    return;
  }

  if (type === 'hardBreak') {
    pushBreak(out);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(PLACEHOLDERS, type)) {
    const placeholder = PLACEHOLDERS[type];
    if (placeholder !== null) {
      out.push(placeholder);
      if (BLOCK_NODES.has(type)) pushBreak(out);
      return;
    }
  }

  // Unknown or structural node: descend. Never drop a subtree just because
  // this file does not recognise its wrapper.
  walk(node.content, out);
  if (BLOCK_NODES.has(type)) pushBreak(out);
}

/**
 * @param {object|string|null|undefined} doc  an ADF document, or a plain
 *   string (some Jira responses still return description as a string on
 *   older API versions / imported data).
 * @param {{ maxLength?: number }} [opts]
 * @returns {{ text: string, truncated: boolean, empty: boolean }}
 */
export function adfToText(doc, { maxLength = 600 } = {}) {
  if (doc == null) return { text: '', truncated: false, empty: true };

  let raw;
  if (typeof doc === 'string') {
    raw = doc;
  } else {
    const out = [];
    walk(doc, out);
    raw = out.join('');
  }

  const normalised = raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (normalised.length === 0) return { text: '', truncated: false, empty: true };
  if (normalised.length <= maxLength) return { text: normalised, truncated: false, empty: false };

  // Cut on a word boundary where one is nearby, so the last thing a signer
  // reads is not half a word.
  const cut = normalised.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > maxLength - 80 ? cut.slice(0, lastSpace) : cut;
  return { text: `${body.trimEnd()}…`, truncated: true, empty: false };
}
