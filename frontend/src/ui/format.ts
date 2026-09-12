/**
 * Display formatting, and the one rule this UI is built around.
 *
 * WHAT MAY APPEAR ON SCREEN. Only identifiers a person in Jira already uses
 * to refer to the thing: the issue key (AUT-1), the project key (AUT), and
 * names — of people, projects, issue types, statuses, roles.
 *
 * WHAT MAY NOT. Internal or platform identifiers: Atlassian account ids
 * (712020:8a3f…), numeric issue ids, numeric project and issue-type ids,
 * status ids, custom field ids (customfield_10050), our own row ids
 * (ct_id, el_id, signature_id) and content hashes. None of these mean
 * anything to the reader, and several of them are identifiers of a person
 * that we have no reason to print — an admin screen listing everyone's
 * account id is a disclosure with no corresponding benefit.
 *
 * The awkward case is a name we could not resolve, and the rule there is the
 * point of this file: DO NOT fall back to the id. `nameOr()` returns a phrase
 * describing the absence instead. A row reading "Unknown issue type" is worse
 * to look at than one reading "10001" and better to ship — "10001" only looks
 * like information. Where an admin genuinely needs to tell two unresolved
 * rows apart, the fix is to resolve the name on the server, which is what
 * src/resolvers/admin.js now does.
 *
 * Row ids are still passed around in props and sent back to resolvers to
 * identify what to revoke. That is fine. This rule is about rendering.
 */

/**
 * A name that may not have resolved.
 *
 * @param name  the resolved display name, if there is one
 * @param noun  what could not be resolved, lowercase — "issue type", "user"
 * @returns the name, or `{ unknown: true }` for the caller to render as an
 *   absence. Returning a discriminated result rather than a string keeps
 *   callers from styling a real name as missing, or vice versa.
 */
export function nameOr(
  name: string | null | undefined,
  noun: string
): { unknown: false; text: string } | { unknown: true; text: string } {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length > 0) return { unknown: false, text: trimmed };
  return { unknown: true, text: `Unknown ${noun}` };
}

/** Initials for an avatar. Two letters at most, from the first and last word. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * A stable colour for an avatar, chosen from the name.
 *
 * Deliberately hue-only variation on a fixed saturation/lightness, so two
 * people never end up with avatars that differ only in brightness, and every
 * swatch stays dark enough for white text to pass contrast.
 */
const AVATAR_COLOURS = [
  '#0055CC', '#5E4DB2', '#943D73', '#AE2E24', '#974F0C',
  '#206A83', '#216E4E', '#5B7F24', '#6E5DC6', '#8F7EE7'
];

export function avatarColour(name: string | null | undefined): string {
  const key = (name ?? '').trim() || '?';
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return AVATAR_COLOURS[Math.abs(hash) % AVATAR_COLOURS.length];
}

/**
 * Absolute date and time, in the reader's locale and timezone.
 *
 * Signature timestamps are shown in full, never as "2 days ago". 21 CFR
 * 11.50(a)(2) wants the date and time of signing on the record, and a
 * relative phrase is not that — it also silently changes meaning depending
 * on when the page happened to be loaded.
 */
export function formatTimestamp(ms: number | string | null | undefined): string | null {
  if (ms == null) return null;
  const num = typeof ms === 'string' && isNaN(Number(ms)) ? Date.parse(ms) : Number(ms);
  if (!Number.isFinite(num) || num <= 0) return null;
  const date = new Date(num);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Date only — for table columns where the time of day is noise. */
export function formatDate(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

/**
 * How long something has been waiting, as a rough phrase.
 *
 * Relative IS right here, unlike for signature timestamps: this is a
 * prioritisation cue on a worklist, not part of the signed record.
 */
export function waitingLabel(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(Number(ms))) return 'Unknown';
  const hours = Math.floor(Number(ms) / 3_600_000);
  if (hours < 1) return 'Under an hour';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
}

/**
 * A changed field's label.
 *
 * Jira returns `summary`/`description` for system fields and
 * `customfield_10050` for the rest. The custom field id is exactly the kind
 * of identifier this file exists to keep off the screen, so an unresolved
 * custom field becomes "A custom field" rather than its id — the diff below
 * it shows the before and after values, which is what the reviewer is
 * actually reading.
 */
export function fieldLabel(fieldId: string, resolvedName?: string | null): string {
  const named = (resolvedName ?? '').trim();
  if (named.length > 0) return named;
  if (fieldId === 'summary') return 'Title';
  if (fieldId === 'description') return 'Description';
  if (/^customfield_\d+$/.test(fieldId)) return 'A custom field';
  // A system field id is already a readable word ("assignee", "priority").
  return fieldId.charAt(0).toUpperCase() + fieldId.slice(1);
}

/** "1 item" / "3 items", so call sites stop hand-rolling the plural. */
export function plural(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
