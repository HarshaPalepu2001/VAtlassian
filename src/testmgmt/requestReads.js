import { contentDigest } from './content.js';

/** One read operation only. Never retain this wrapper across resolver calls or writes. */
export function requestReads(deps) {
  const result = { ...deps };
  const methods = ['readIssueAsUser', 'readVersion', 'listSignatures', 'readProject', 'readDraft',
    'readCollectionDraft', 'readCollectionRevision', 'listCollectionRevisions', 'resolveTestSources',
    'verifyEvidence', 'readBlockingDefects', 'validateRunPlanningSnapshot'];
  for (const name of methods) {
    if (typeof deps[name] !== 'function') continue;
    const reads = new Map();
    result[name] = (...args) => {
      // Plan validation consumes these exact frozen fields; different preconditions must never reuse a valid proof.
      const values = name === 'validateRunPlanningSnapshot' ? [args[0]?.projectId,
        args[0]?.planningSnapshot?.plan ?? null, args[0]?.planningSnapshot?.preconditions ?? [], args[2] ?? null] : args;
      const key = contentDigest(values);
      if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => deps[name](...args)));
      return reads.get(key);
    };
  }
  return result;
}
