import ForgeResolver from '@forge/resolver';
import * as panel from '../usecases/panel.js';
import * as panelSummary from '../usecases/panelSummary.js';
import * as panelEvidence from '../usecases/panelEvidence.js';
import * as approval from '../usecases/approval.js';
import * as drift from '../usecases/drift.js';
import * as restore from '../usecases/restore.js';
import * as queue from '../usecases/queue.js';
import * as report from '../usecases/report.js';
import * as signing from '../usecases/signing.js';
import * as harness from './harness.js';
import { defineWebAuthnResolvers } from '../usecases/webauthn.js';
import * as confluence from '../usecases/confluence.js';
import { withRequestCache } from '../lib/cache.js';
import { harnessLog } from '../lib/harnessLogger.js';

const Resolver = ForgeResolver.default ?? ForgeResolver;
const resolver = new Resolver();
resolver.define('panel:getState', ({ payload, context }) => panel.getState({ payload, context }));
resolver.define('panel:getSummary', ({ payload, context }) => panelSummary.getSummary({ payload, context }));
resolver.define('panel:getEvidence', ({ payload, context }) => panelEvidence.getEvidence({ payload, context }));
resolver.define('panel:getGlanceState', ({ payload, context }) => panel.getGlanceState({ payload, context }));
resolver.define('signature:challenge', ({ payload, context }) => approval.challenge({ payload, context }));
resolver.define('approval:challenge', ({ payload, context }) => approval.challenge({ payload, context }));
resolver.define('signature:submit', ({ payload, context }) => approval.submit({ payload, context }));
resolver.define('approval:submit', ({ payload, context }) => approval.submit({ payload, context }));
resolver.define('approval:retryTransition', ({ payload, context }) => approval.retryTransition({ payload, context }));
resolver.define('drift:getState', ({ payload, context }) => drift.getState({ payload, context }));
resolver.define('drift:getDiff', ({ payload, context }) => drift.getDiff({ payload, context }));
resolver.define('restore:getState', ({ payload, context }) => restore.getState({ payload, context }));
resolver.define('restore:retry', ({ payload, context }) => restore.retry({ payload, context }));
resolver.define('queue:list', ({ payload, context }) => queue.list({ payload, context }));
resolver.define('report:get', ({ payload, context }) => report.get({ payload, context }));
resolver.define('report:generate', ({ payload, context }) => report.generate({ payload, context }));
resolver.define('signing:context', ({ payload, context }) => signing.signingContext({ payload, context }));
resolver.define('harness:logAction', ({ payload, context }) => harness.logAction({ payload, context }));
resolver.define('harness:inspectIssue', ({ payload, context }) => harness.inspectIssue({ payload, context }));

// Confluence endpoints
resolver.define('confluence:getSpaceRole', confluence.getSpaceRole);
resolver.define('confluence:getPageStatus', confluence.getPageStatus);
resolver.define('confluence:protectPage', confluence.protectPage);
resolver.define('confluence:checkOut', confluence.checkOut);

defineWebAuthnResolvers(resolver);
const definitions = resolver.getDefinitions();

export const handler = async (...args) => {
  const req = args[0];
  const functionKey = req?.call?.functionKey;
  const isHarnessLog = functionKey === 'harness:logAction';
  const startedAt = Date.now();

  try {
    const result = await withRequestCache(() => definitions(...args));
    const durationMs = Date.now() - startedAt;

    if (!isHarnessLog) {
      const isSuccess = result?.success !== false && result?.ok !== false && !result?.error;
      harnessLog(isSuccess ? 'RESOLVER' : 'ERROR', `resolver:${functionKey}`, {
        functionKey,
        durationMs,
        issueKey: req?.payload?.issueKey ?? req?.context?.extension?.issue?.key,
        accountId: req?.context?.accountId,
        success: isSuccess,
        reason: result?.reason,
        error: result?.error,
        transitioned: result?.transitioned
      }, isSuccess ? 'INFO' : 'WARN');
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    harnessLog('ERROR', `resolver:${functionKey}:failed`, {
      functionKey,
      durationMs,
      issueKey: req?.payload?.issueKey ?? req?.context?.extension?.issue?.key,
      accountId: req?.context?.accountId,
      error: error?.message,
      reason: error?.reason
    }, 'ERROR');
    throw error;
  }
};

