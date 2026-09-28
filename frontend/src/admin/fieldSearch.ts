import type { AvailableField, ControlledField } from './types';

/**
 * FIND A FIELD TO TRACK — across everything the Controlled fields page knows.
 *
 * The page's lists come from admin:fieldSetup, which already applies the rules
 * for what may be tracked: Jira's own catalogue for the project, minus the
 * fields that must never be (comments, worklogs, watchers, and what Jira
 * recomputes — content.js IGNORED_FIELDS). So a search over those lists can
 * only ever offer a field the resolver will accept; nothing here decides that.
 *
 * Matches name or id, so an admin can paste `customfield_10015` as easily as
 * type "start". Names that START with the query come first.
 */
export type FieldStatus = 'tracked' | 'excluded' | 'available';
export type FieldHit = { fieldId: string; fieldName: string; kind?: string; status: FieldStatus; pinned?: boolean };

type Lists = {
  controlled: (ControlledField & { pinned?: boolean })[];
  excluded: AvailableField[];
  available: AvailableField[];
};

export function searchFields(lists: Lists, query: string): FieldHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all: FieldHit[] = [
    ...lists.controlled.map(f => ({ fieldId: f.field_id, fieldName: f.field_name, kind: f.field_kind,
      status: 'tracked' as const, pinned: f.pinned })),
    ...lists.excluded.map(f => ({ fieldId: f.fieldId, fieldName: f.fieldName, kind: f.suggestedKind, status: 'excluded' as const })),
    ...lists.available.map(f => ({ fieldId: f.fieldId, fieldName: f.fieldName, kind: f.suggestedKind, status: 'available' as const }))
  ];
  const name = (h: FieldHit) => (h.fieldName ?? h.fieldId).toLowerCase();
  return all
    .filter(h => name(h).includes(q) || h.fieldId.toLowerCase().includes(q))
    .sort((a, b) => Number(!name(a).startsWith(q)) - Number(!name(b).startsWith(q)) || name(a).localeCompare(name(b)));
}
