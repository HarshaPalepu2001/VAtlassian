import test from 'node:test';
import assert from 'node:assert/strict';
import { issueStatus as handler } from '../src/resolvers/issueStatus.js';
const payload = { extension: { issue: { id: '123', typeId: '4' }, project: { id: '10' } } };
function deps(review, controls = { incidents: [], gateFindings: [] }) {
  return { getReview: async id => { assert.equal(id, 123); return review; }, issueControlStatus: async () => controls };
}
test('collapsed issue context shows drift without opening the custom UI', async () => {
  assert.deepEqual(await handler(payload, deps({ state: 'DRIFTED', drift_count: 2 })),
    { status: { type: 'lozenge', value: { label: 'Changes need review', type: 'moved' } } });
});
test('control incidents and open workflow findings override healthy baseline', async () => {
  for (const controls of [{ incidents: [{ event_type: 'UNAUTHORIZED_TRANSITION' }], gateFindings: [] },
    { incidents: [], gateFindings: [{ finding_type: 'MISSING_VALIDATOR' }] }]) {
    assert.equal((await handler(payload, deps({ state: 'BASELINED' }, controls))).status.value.label, 'Control alert');
  }
});
test('status lookup failure cannot appear as an approved or healthy baseline', async () => {
  const result = await handler(payload, { ...deps(null), getReview: async () => { throw Error('unavailable'); } });
  assert.equal(result.status.value.label, 'Status unavailable');
});
test('issue status validates context before making any read', async () => {
  const result = await handler({ extension: { issue: { id: 'unsafe' } } }, {});
  assert.equal(result.status.value.label, 'Status unavailable');
});
