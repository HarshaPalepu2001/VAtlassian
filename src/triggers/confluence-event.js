import { executeQuery } from '../lib/db.js';

export async function run(event, context) {
  const accountId = event.atlassianId || event.context?.accountId;
  if (!accountId) return;

  const content = event.page || event.blogpost || event.attachment || event.whiteboard || event.database || event.folder;
  const contentId = content?.id;
  const contentType = content?.type || event.eventType?.split(':').pop();

  if (!contentId) return;

  const isApp = event.context?.appId === context?.appId || accountId === context?.accountId;

  if (isApp) {
    const { ConfluenceAdapter } = await import('../lib/confluenceAdapter.js');
    const { GovernedObjectRef } = await import('../lib/governanceCore.js');
    const adapter = new ConfluenceAdapter();
    const ref = new GovernedObjectRef('confluence', context?.workspaceId, content?.spaceId, contentType, contentId, content?.version?.number);
    await adapter.reconcile(ref);
    return;
  }

  await executeQuery(
    `INSERT INTO va_events (id, product, type, content_id, timestamp) VALUES (?, ?, ?, ?, ?)`,
    [event.eventType + '_' + Date.now(), 'confluence', contentType, contentId, Date.now()]
  );
  
  const { Queue } = await import('@forge/events');
  const queue = new Queue({ key: 'confluence-reconcile' });
  await queue.push({ contentId, contentType, eventType: event.eventType });
}
