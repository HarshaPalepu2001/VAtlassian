import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

/**
 * Import every backend module.
 *
 * Pure-function tests do not exercise the @forge/* imports in resolvers,
 * triggers, jobs, stores, and the gate. This check catches missing import
 * paths, mismatched export names, and top-level statements that throw on
 * load before deployment.
 *
 * Run with `npm run smoke` after `npm install`.
 */

const ROOT = resolve(import.meta.dirname, '..');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Modules that cannot import outside the Forge runtime.
 *
 * The exception map is empty. @forge/llm accesses the runtime at module load
 * and throws "Forge runtime not found." elsewhere. It once prevented
 * lib/report.js and its resolvers from loading here. Importing it lazily in
 * the calling function fixed that and improved cold starts and failure
 * handling.
 *
 * Each exception needs a reason because it excludes backend code from this
 * pre-deployment check. Try removing the load-time dependency before adding
 * an exception.
 */
const RUNTIME_ONLY = new Map();

const files = walk(join(ROOT, 'src')).sort();
let failed = 0;
let skipped = 0;

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  try {
    await import(pathToFileURL(file).href);
    console.log('ok      ', rel);
  } catch (e) {
    const message = String(e.message).split('\n')[0];
    const reason = RUNTIME_ONLY.get(rel);
    if (reason && /Forge runtime not found/.test(message)) {
      skipped++;
      console.log('runtime ', rel, '->', reason);
      continue;
    }
    failed++;
    console.log('FAIL    ', rel, '->', message);
  }
}

console.log(
  `\n${files.length - failed - skipped}/${files.length} modules import cleanly`
  + (skipped ? `, ${skipped} need the Forge runtime` : '')
  + (failed ? `, ${failed} FAILED` : '')
);
process.exit(failed ? 1 : 0);
