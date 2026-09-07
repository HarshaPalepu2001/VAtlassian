import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('manifest.yml must not contain permissions.external or remotes', () => {
  const manifest = fs.readFileSync('manifest.yml', 'utf8');
  assert.equal(manifest.includes('permissions.external'), false, 'permissions.external must not appear in manifest.yml');
  assert.equal(manifest.includes('remotes'), false, 'remotes must not appear in manifest.yml');
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
