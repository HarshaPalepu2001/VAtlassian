import * as native from './providers/native.js';
import * as esignature from './providers/esignature.js';
import * as jsm from './providers/jsm.js';
import * as biometric from './providers/biometric.js';
import { FailClosed } from '../errors.js';
const providers = new Map([native, jsm, esignature, biometric].map(provider => [provider.getLevel(), provider]));
export function providerFor(level) {
  const provider = providers.get(level);
  if (!provider) throw new FailClosed('NOT_CONFIGURED');
  return provider;
}
export function describeProviders() { return [...providers.values()].map(provider => provider.describe()); }
