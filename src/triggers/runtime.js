import { recordIncident } from '../usecases/incidents.js';
import { collectAffectedTrees, affectedTreeRoots, collectTree } from '../lib/collect.js';

/**
 * Load production trigger dependencies through a dynamic import.
 * This keeps ../usecases/incidents.js and its dependencies out of trigger
 * modules that need only part of this bundle. Tests can supply their own
 * dependencies directly.
 */
export async function triggerRuntime() {
  return {
    recordIncident,
    collectAffectedTrees,
    affectedTreeRoots,
    collectTree
  };
}
