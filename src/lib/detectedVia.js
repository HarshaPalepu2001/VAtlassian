/**
 * How a drift observation came to be made.
 *
 * Shared by lib/collect.js and lib/treeCollect.js (single-issue and aggregate
 * tree collection) in its own file so neither module has to import the other
 * just to share this one constant.
 */
export const DETECTED_VIA = { EVENT: 'EVENT', SWEEP: 'SWEEP', RECONCILE: 'RECONCILE' };
