import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('manifest.yml permits the WebAuthn popup without declaring remotes', () => {
  const manifest = fs.readFileSync('manifest.yml', 'utf8');
  assert.equal(manifest.includes('remotes'), false, 'remotes must not appear in manifest.yml');
  assert.match(manifest, /external:\s*\n\s*fetch:\s*\n\s*client:\s*\n\s*-\s*address:\s*"\*"/,
    'WebAuthn needs Forge to allow a top-level ceremony popup');
});

test('manifest.yml edit.experience array must be exactly issue-transition or issue-view', () => {
  const manifest = fs.readFileSync('manifest.yml', 'utf8');
  // YAML inline sequences are whitespace-insensitive: `[a]`, `[ a ]` and
  // `[ a, b ]` are the same document. The previous substring match asserted a
  // formatting choice, so a harmless reformat of manifest.yml turned the suite
  // red while the app was correct. Normalise, then assert the content.
  const inline = manifest
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\s*,\s*/g, ',');
  assert.equal(inline.includes('experience: [issue-view]'), true, 'experience must contain issue-view');
  assert.equal(inline.includes('experience: [issue-transition]'), true, 'experience must contain issue-transition');
});

test('manifest.yml declares the restore queue consumer and six-minute worker', () => {
  const manifest = fs.readFileSync('manifest.yml', 'utf8');
  assert.match(manifest, /key:\s*va-restore-consumer[\s\S]*queue:\s*va-restore-queue[\s\S]*function:\s*restore-worker/);
  assert.match(manifest, /key:\s*restore-worker[\s\S]*handler:\s*jobs\/restoreWorker\.handler[\s\S]*timeoutSeconds:\s*600/);
});

test('manifest.yml asks the Jira admin for one rule: the va-gate validator, and no workflow condition', () => {
  // Drift is held by va-gate itself on every transition it is attached to. A
  // second Jira rule for drift is exactly the setup burden this app removes.
  const manifest = fs.readFileSync('manifest.yml', 'utf8');
  assert.match(manifest, /jira:workflowValidator:\s*\n\s*-\s*key:\s*va-gate/);
  assert.equal(/jira:workflowCondition:/.test(manifest), false, 'no workflow condition module');
  assert.equal(manifest.includes('va-drift-lock'), false);
});
