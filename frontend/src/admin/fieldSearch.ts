import type { AvailableField, ControlledField } from './types';

/**
 * Search the trackable fields returned by admin:fieldSetup. The resolver
 * excludes comments, worklogs, watchers and recomputed fields using
 * content.js IGNORED_FIELDS. This client does not decide trackability.
 * Match names or ids, with name-prefix matches first.
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
