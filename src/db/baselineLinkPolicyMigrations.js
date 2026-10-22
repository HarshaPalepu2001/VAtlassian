/** Nullable snapshots leave every historical hash and signature exactly v1. */
export const BASELINE_LINK_POLICY_MIGRATIONS = [
  { id: 'v134_baseline_link_policy', sql: 'ALTER TABLE va_baseline ADD COLUMN link_policy MEDIUMTEXT NULL' },
  { id: 'v135_approval_link_policy', sql: 'ALTER TABLE va_approval ADD COLUMN link_policy MEDIUMTEXT NULL' },
  { id: 'v136_baseline_node_link_policy', sql: 'ALTER TABLE va_baseline_node ADD COLUMN link_policy MEDIUMTEXT NULL' }
];
