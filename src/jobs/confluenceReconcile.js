import { ConfluenceAdapter } from '../lib/confluenceAdapter.js';
import { GovernedObjectRef } from '../lib/governanceCore.js';

/** Consumer of confluence-reconcile. The job is the queued event's `body`. */
export async function handler(event, context) {
  const { contentId, contentType } = event?.body ?? {};
  if (!contentId || !contentType) return;

  // No user behind a queue job: read as the app.
  const adapter = new ConfluenceAdapter({ asApp: true });
  // Using generic ref because workspaceId and spaceId might not be fully known here,
  // but adapter.reconcile primarily needs contentId and contentType.
  const ref = new GovernedObjectRef('confluence', context?.workspaceId || 'local', null, contentType, contentId, null);
  await adapter.reconcile(ref);
}
