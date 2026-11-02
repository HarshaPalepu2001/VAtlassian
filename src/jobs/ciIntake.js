import { createTestIntake } from '../usecases/testIntake.js';
import { validIntakeId } from '../testmgmt/intake.js';

// All response bodies live in manifest.yml. Neither submitted results nor
// credentials, identifiers or error text are returned by this webtrigger.
export const CI_INTAKE_OUTPUTS = Object.freeze([
  { key: 'accepted', statusCode: 202, contentType: 'application/json', body: '{"accepted":true}' },
  { key: 'rejected', statusCode: 400, contentType: 'application/json', body: '{"accepted":false}' },
  { key: 'unauthorized', statusCode: 401, contentType: 'application/json', body: '{"accepted":false}' },
  { key: 'too-large', statusCode: 413, contentType: 'application/json', body: '{"accepted":false}' },
  { key: 'unavailable', statusCode: 503, contentType: 'application/json', body: '{"accepted":false}' }
]);

function header(headers, name) {
  const entries = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  if (entries.length !== 1) return null;
  const value = entries[0][1];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

export function createCiIntakeHandler(usecase) {
  return async request => {
    if (request?.method !== 'POST' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(request.headers, 'content-type') ?? '')) return { outputKey: 'rejected' };
    try {
      await usecase.receive({ authorization: header(request.headers, 'authorization'), body: request.body });
      return { outputKey: 'accepted' };
    } catch (error) {
      if (error?.reason === 'INTAKE_UNAUTHORIZED') return { outputKey: 'unauthorized' };
      if (error?.reason === 'INTAKE_TOO_LARGE') return { outputKey: 'too-large' };
      if (['INVALID_INPUT', 'INTAKE_MAPPING_INVALID', 'IDEMPOTENCY_CONFLICT', 'EXECUTION_CANDIDATE_MISMATCH'].includes(error?.reason)) return { outputKey: 'rejected' };
      return { outputKey: 'unavailable' };
    }
  };
}

export function createCiIntakeWorker(usecase) {
  return async event => {
    const receiptId = (event?.body ?? event)?.receiptId;
    if (!validIntakeId(receiptId)) return { outcome: 'MALFORMED' };
    return usecase.process({ receiptId });
  };
}

async function usecase() {
  const deps = await (await import('../testmgmt/runtime.js')).testManagementRuntime();
  return createTestIntake(deps);
}
export async function runCiIntake(request) {
  try { return await createCiIntakeHandler(await usecase())(request); }
  catch { return { outputKey: 'unavailable' }; }
}
export async function runCiIntakeWorker(event) {
  // Throwing keeps transient SQL, audit and queue delivery failures recoverable.
  // Expired/revoked authorization stops processing; authenticated UI can retry
  // if the authority is still valid, or prepare a new candidate otherwise.
  return createCiIntakeWorker(await usecase())(event);
}
