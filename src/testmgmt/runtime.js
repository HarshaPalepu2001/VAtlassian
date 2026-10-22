/**
 * The production dependencies of the test-management use cases, in one place.
 * Tests build the same shape from fakes (test/testmgmt-*.test.js).
 */
export async function testManagementRuntime() {
  const [store, jira, exclusion, signing, ledger, auditStore, totp, planningStore, bugStore, evidence, proof, reporting, planning, retestStore, retestJira] = await Promise.all([
    import('./store.js'), import('./jira.js'), import('./treeExclusion.js'), import('./signing.js'),
    import('../lib/ledger.js'), import('../db/store.js'), import('../lib/approval/totpVerification.js'),
    import('./planningStore.js'), import('./bugStore.js'), import('./evidence.js'), import('./proof.js'),
    import('./sourceRuntime.js'), import('../usecases/testPlanning.js'), import('./retestStore.js'), import('./retestJira.js')
  ]);
  const audit = (event) => ledger.append(auditStore.auditStore, { eventId: auditStore.newId(), ...event });
  const deps = {
    ...store, ...jira, ...planningStore, ...bugStore, ...retestStore, ...retestJira,
    retainEvidence: evidence.retainEvidence, verifyEvidence: evidence.verifyEvidence,
    readRetainedEvidence: evidence.readRetainedEvidence, readRetainedEvidenceRange: evidence.readRetainedEvidenceRange,
    testManagementRole: exclusion.testManagementRole,
    isEligibleFor: signing.isEligibleFor, roleHolders: signing.roleHolders,
    recordSignature: (args, extra) => signing.recordSignature(args, extra),
    verifyTotp: (accountId, code, options) => totp.verifyTotp(accountId, code, options),
    audit,
    tryAudit: (event) => auditStore.tryAppend(event),
    newHexId: () => auditStore.newId().toString('hex'),
    now: () => Date.now()
  };
  deps.verifyVersionProof = version => proof.verifyVersionProof(version, deps);
  deps.verifyRunProof = (run, version) => proof.verifyRunProof(run, version, deps);
  deps.validateRunPlanningSnapshot = (run, _version, { viewer } = {}) => planning.createTestPlanning(deps).validateRunPlanningSnapshot(run,
    typeof viewer === 'string' ? { accountId: viewer } : viewer);
  return reporting.sourceReportingRuntime(deps);
}
