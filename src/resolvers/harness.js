import * as harness from '../usecases/harness.js';

export async function logAction(req) {
  return harness.logAction(req);
}

export async function inspectIssue(req) {
  return harness.inspectIssue(req);
}
