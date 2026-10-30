#!/usr/bin/env node
/**
 * Creates the site-wide trace link types from plan.mjs. Read-only by default.
 * Existing types are reused by exact name and never modified.
 *
 *   node scripts/requirements-setup/link-types.mjs
 *   node scripts/requirements-setup/link-types.mjs --apply
 */
import { createClient } from './jira.mjs';
import { PLAN } from './plan.mjs';
import { openLedger } from './state.mjs';
import { findLinkType } from './link-type.mjs';

const APPLY = process.argv.includes('--apply');
const jira = createClient({ write: APPLY });
const log = (message) => console.log(message);
const { file: stateFile, ensure } = openLedger(jira, { apply: APPLY, log });

log(`${APPLY ? 'APPLYING' : 'DRY RUN (read-only)'} on ${jira.site}\n`);
const live = (await jira.get('/rest/api/3/issueLinkType')).issueLinkTypes ?? [];

for (const linkType of PLAN.linkTypes) {
  await ensure('linkType', linkType.name, {
    allowForeign: true,
    existing: async () => findLinkType(live, linkType.name),
    create: async () => (await jira.post('/rest/api/3/issueLinkType', linkType)).id
  });
}

log(`\n${APPLY ? 'Done.' : 'Dry run complete. Nothing was changed.'} Ledger: ${stateFile}`);
