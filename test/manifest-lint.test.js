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
  assert.equal(manifest.includes('experience: [issue-view]'), true, 'experience must contain issue-view');
  assert.equal(manifest.includes('experience: [issue-transition]'), true, 'experience must contain issue-transition');
});
