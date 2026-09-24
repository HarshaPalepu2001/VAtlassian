import { ConfluenceAdapter } from '../lib/confluenceAdapter.js';
import { GovernedObjectRef } from '../lib/governanceCore.js';

export async function handler(event, context) {
  const { contentId, contentType, eventType } = event;
  if (!contentId || !contentType) return;

  const adapter = new ConfluenceAdapter();
  // Using generic ref because workspaceId and spaceId might not be fully known here,
  // but adapter.reconcile primarily needs contentId and contentType.
  const ref = new GovernedObjectRef('confluence', context?.workspaceId || 'local', null, contentType, contentId, null);
  await adapter.reconcile(ref);
}
