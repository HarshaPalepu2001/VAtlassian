import { recordIncident } from '../usecases/incidents.js';
import { collectAffectedTrees, affectedTreeRoots, collectTree } from '../lib/collect.js';

/**
 * The real dependencies a trigger falls back on outside a test.
 *
 * Behind a dynamic import so requiring it doesn't drag ../usecases/incidents.js
 * (and everything it pulls in) into every trigger module at load time — most
 * triggers need only a slice of this, and most of the time a test supplies its
 * own slice directly instead.
 */
export async function triggerRuntime() {
  return {
    recordIncident,
    collectAffectedTrees,
    affectedTreeRoots,
    collectTree
  };
}
