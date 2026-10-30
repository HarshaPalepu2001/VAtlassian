/**
 * Display names and Jira issue/project keys. Do not render account ids,
 * numeric Jira ids, custom field ids, internal row ids or content hashes.
 * Resolve names on the server. If a name is missing, nameOr() describes the
 * missing value instead of falling back to its id.
 *
 * Row ids may still identify records in props and resolver requests.
 */

/**
 * A name that may not have resolved.
 *
 * @param name  the resolved display name, if there is one
 * @param noun  what could not be resolved, lowercase, for example "issue type", "user"
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
 * Absolute date and time in the reader's locale and timezone.
 * Signature timestamps use the full date and time required by 21 CFR
 * 11.50(a)(2). Relative timestamps change meaning as time passes.
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

/** Date only for table columns that do not need a time. */
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
 * A changed field's label. Use a resolved name when available. Unresolved
 * custom field ids become "A custom field" so internal ids stay off screen.
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

/**
 * "2 days ago", for a change on a worklist or a diff row. Never for a
 * signature, which formatTimestamp() spells out in full. Callers put the
 * absolute time on hover so the exact instant is always one step away.
 */
export function relativeTime(ms: number | null | undefined, now: number = Date.now()): string | null {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return null;
  const elapsed = now - Number(ms);
  if (elapsed < 60_000) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return days === 1 ? 'yesterday' : `${days} days ago`;
  return formatDate(Number(ms));
}

/**
 * Elapsed time since approval, such as "+3 days" or "+5 hours".
 * The diff shows this beside each edit so reviewers need not calculate it.
 */
export function sinceLabel(fromMs: number | null | undefined, toMs: number | null | undefined): string | null {
  if (fromMs == null || toMs == null) return null;
  const from = Number(fromMs); const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) return null;
  const hours = Math.floor((to - from) / 3_600_000);
  if (hours < 1) return 'within the hour';
  if (hours < 24) return `+${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `+${days} day${days === 1 ? '' : 's'}`;
}

/** Whole days between two instants, never negative. */
export function daysBetween(fromMs: number | null | undefined, toMs: number = Date.now()): number | null {
  if (fromMs == null || !Number.isFinite(Number(fromMs)) || Number(fromMs) <= 0) return null;
  return Math.max(0, Math.floor((toMs - Number(fromMs)) / 86_400_000));
}

/** "1 item" / "3 items", so call sites stop hand-rolling the plural. */
export function plural(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
