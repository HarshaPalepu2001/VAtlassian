import ForgeResolver from '@forge/resolver';
import * as totp from '../usecases/totp.js';
import * as harness from './harness.js';
import { withRequestCache } from '../lib/cache.js';
const Resolver = ForgeResolver.default ?? ForgeResolver;
const resolver = new Resolver();
resolver.define('totp:checkStatus', ({payload,context}) => totp.checkStatus({payload,context}));
resolver.define('totp:deviceStatus', ({payload,context}) => totp.deviceStatus({payload,context}));
resolver.define('totp:enrol', ({payload,context}) => totp.enrol({payload,context}));
resolver.define('totp:confirm', ({payload,context}) => totp.confirm({payload,context}));
resolver.define('totp:attest', ({payload,context}) => totp.attest({payload,context}));
// Client telemetry only. inspectIssue reads approvals and audit rows as the app
// with no issue permission check, so it is not exposed on this every-user page.
resolver.define('harness:logAction', ({payload,context}) => harness.logAction({payload,context}));
const definitions = resolver.getDefinitions();
export const handler = (...args) => withRequestCache(() => definitions(...args));
