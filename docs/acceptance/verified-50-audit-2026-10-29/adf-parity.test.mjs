import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAdf as iterativeAdf } from '../../../src/lib/content.js';
// Exact previous implementation, read from a87375a^:src/lib/content.js.
const ADF_VOLATILE_KEYS = new Set(['localId', 'version']);
function normaliseAdf(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.map(normaliseAdf);
  if (typeof node !== 'object') return node;

  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (ADF_VOLATILE_KEYS.has(key)) continue;
    out[key] = normaliseAdf(node[key]);
  }
  return out;
}
let seed = 246813579;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2**32; }
function fixture(depth) {
  if (depth === 0) return [null, true, false, 'unicode \u03bb', 42][Math.floor(random()*5)];
  const kind = Math.floor(random()*3);
  if (kind === 0) return [fixture(depth-1), fixture(depth-1), fixture(0)];
  return { type: 'paragraph', localId: String(random()), version: 1,
    z: fixture(depth-1), content: [fixture(depth-1)], a: 'audited' };
}
test('audit: iterative normalisation is byte-identical to the previous code on 60 seeded fixtures', () => {
  for (let i = 0; i < 60; i++) {
    const v = fixture(1 + i % 5);
    assert.equal(JSON.stringify(iterativeAdf(v)), JSON.stringify(normaliseAdf(v)), `fixture ${i}`);
  }
});
test('audit: previous code overflows on a 10,000-level input; iterative code reaches the same leaf', () => {
  let input = { type: 'text', text: 'leaf' };
  for (let i = 0; i < 10000; i++) input = { type: 'paragraph', localId: String(i), content: [input] };
  assert.throws(() => normaliseAdf(input), RangeError);
  let result = iterativeAdf(input);
  for (let i = 0; i < 10000; i++) result = result.content[0];
  assert.deepEqual(result, { text: 'leaf', type: 'text' });
});
