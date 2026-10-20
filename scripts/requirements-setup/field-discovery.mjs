export async function findCustomFieldsByName(jira, name) {
  const fields = await jira.all(`/rest/api/3/field/search?query=${encodeURIComponent(name)}`);
  const wanted = String(name).trim().toLowerCase();
  return fields.filter((field) => field.schema?.custom && String(field.name).trim().toLowerCase() === wanted);
}

export async function findReusableCustomField(jira, name) {
  const matches = await findCustomFieldsByName(jira, name);
  if (matches.length <= 1) return matches[0] ?? null;
  const established = [];
  for (const field of matches) {
    const screens = await jira.all(`/rest/api/3/field/${field.id}/screens`);
    if (screens.length) established.push(field);
  }
  if (established.length === 1) return established[0];
  throw new Error(`Several custom fields are named "${name}" and ${established.length} are established on screens (${matches.map((field) => field.id).join(', ')}).`);
}
