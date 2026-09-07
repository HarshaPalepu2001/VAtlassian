import { sweep } from './reconcile.js';
import { DETECTED_VIA } from '../lib/collect.js';

/** Re-read another oldest slice for missed updates. Use Baseline's collector,
 * which checks the live digests even when Jira supplies no changelog event.
 * Advancing last_checked_at is the collector's responsibility, so this pass
 * continues the reconcile queue instead of maintaining a competing cursor.
 */
export function run(options = {}) {
  return sweep({...options, detectedVia:DETECTED_VIA.SWEEP});
}
export const handler = run;
