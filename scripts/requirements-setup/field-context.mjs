export function planFieldContext({ contexts, scopedName }) {
  const scoped = contexts.filter((context) => context.name === scopedName);
  if (scoped.length > 1) throw new Error(`Several contexts are named "${scopedName}".`);
  return {
    scopedContext: scoped[0] ?? null,
    createScopedContext: scoped.length === 0,
    // Jira has refused deletion of a default global context since April 2026
    // (CHANGE-3019). The scoped context is a VAT/type-specific variant; the
    // work type's screen scheme controls where the field is displayed.
    contextIdsToDelete: []
  };
}
