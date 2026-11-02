import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/jobs/ciIntake.js') && specifier === '../testmgmt/runtime.js') return { url: 'ci-entrypoint:runtime', shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url === 'ci-entrypoint:runtime') return { format: 'module', shortCircuit: true, source: 'export const testManagementRuntime = async () => ({readIntakeToken: async () => null});' };
  return next(url, context);
} });
test('Forge invocation context is never mistaken for injected runtime dependencies', async () => {
  const { runCiIntake } = await import('../src/jobs/ciIntake.js');
  const body = JSON.stringify({ idempotencyKey: 'entrypoint-1234', executionIssueId: '12', grantId: 'a'.repeat(32), reportedBuild: { id: 'A' }, results: [{ runId: 'b'.repeat(32), expectedRevision: 1, steps: [{ stepId: 's', iterationId: 'default', status: 'PASSED' }] }] });
  const result = await runCiIntake({ method: 'POST', headers: { 'content-type': ['application/json'], authorization: [`Bearer tmci_${'c'.repeat(32)}_${'d'.repeat(64)}`] }, body }, { installationId: 'forge-context' });
  assert.deepEqual(result, { outputKey: 'unauthorized' });
});
