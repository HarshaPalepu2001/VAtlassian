import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

/**
 * Import every backend module.
 *
 * The unit tests cover the pure logic; this covers the half of the codebase
 * they cannot reach — resolvers, triggers, jobs, stores and the gate all import
 * @forge/* and so are invisible to a pure-function test. Almost every mistake
 * that survives review in a Forge app is a bad import path, a name that was
 * renamed in one file and not another, or a top-level statement that throws on
 * load. Every one of those shows up here and nowhere else until deploy.
 *
 * Run with `npm run smoke` (needs `npm install` first).
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
 * Modules that CANNOT import outside the Forge runtime, and why.
 *
 * DELIBERATELY EMPTY. @forge/llm reaches into the runtime at module load and
 * throws "Forge runtime not found." anywhere else, which once made lib/report.js
 * and every resolver importing it unloadable here. The fix was to import it
 * lazily inside the one function that calls it — better for cold starts and for
 * degradation, not just for this check.
 *
 * An entry here is a confession that part of the backend cannot be verified
 * before deploy, so each one needs a reason. Reaching for this map should be the
 * last resort, after trying to remove the load-time dependency.
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
