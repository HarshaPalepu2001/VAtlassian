import { executeQuery } from '../lib/db.js';

/**
 * Every page, blog post and attachment event on the site arrives here, and
 * almost none concern content this app governs — so that is checked first,
 * and nothing is written or queued for the rest.
 *
 * Governed content is reconciled off this trigger, by jobs/confluenceReconcile.js,
 * whatever made the change (the app's own writes included): the consumer reads
 * as the app and re-measures the page against its baseline either way.
 */
export async function run(event) {
  const accountId = event.atlassianId || event.context?.accountId;
  if (!accountId) return;

  const content = event.page || event.blogpost || event.attachment || event.whiteboard || event.database || event.folder;
  const contentId = content?.id;
  const contentType = content?.type || event.eventType?.split(':').pop();

  if (!contentId) return;

  const { getSubjectState } = await import('../db/confluenceStore.js');
  if (!await getSubjectState(String(contentId))) return;

  await executeQuery(
    `INSERT INTO va_events (id, product, type, content_id, timestamp) VALUES (?, ?, ?, ?, ?)`,
    [event.eventType + '_' + Date.now(), 'confluence', contentType, contentId, Date.now()]
  );

  const { Queue } = await import('@forge/events');
  const queue = new Queue({ key: 'confluence-reconcile' });
  // A Forge queue event carries its payload under `body`; anything else is
  // refused by the queue before it is sent.
  await queue.push({ body: { contentId: String(contentId), contentType, eventType: event.eventType } });
}
