export function createMetaFieldIds(body) {
  const fields = Array.isArray(body?.fields) ? body.fields
    : Array.isArray(body?.results) ? body.results
      : Array.isArray(body?.values) ? body.values
        : [];

  return new Set(fields.map((field) => field?.fieldId ?? field?.key ?? field?.id).filter(Boolean));
}

export function missingFieldAssociations(expectedFieldIds, createMetaBody) {
  const visible = createMetaFieldIds(createMetaBody);
  return [...new Set(expectedFieldIds)].filter((fieldId) => !visible.has(fieldId));
}

export function fieldAssociationPayload(projectId, fieldIds) {
  const unique = [...new Set(fieldIds)];
  if (!unique.length) throw new Error('At least one field is required for a Jira field association.');
  return {
    associationContexts: [{ identifier: Number(projectId), type: 'PROJECT_ID' }],
    fields: unique.map((identifier) => ({ identifier, type: 'FIELD_ID' }))
  };
}
