import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVaultTier, rememberedVaultTier, TIER_CONFIG_KEY } from '../src/lib/vaultTier.js';

function deps({ cached = null, site = null, probe = async () => ({ ok: true, status: 200 }) } = {}) {
  const saved = [];
  const events = [];
  return {
    saved, events,
    getConfig: async key => { assert.equal(key, TIER_CONFIG_KEY); return cached; },
    setConfig: async (key, value) => saved.push([key, value]),
    getVaultSite: async () => site,
    probeConfluence: probe,
    tryAppend: async event => events.push(event),
    EVENT: { VAULT_TIER_DETECTED: 'VAULT_TIER_DETECTED' },
    now: () => 5
  };
}

test('a remembered answer is used without asking Confluence', async () => {
  const d = deps({ cached: { tier: 'OBJECT_STORE', reason: 'NO_CONFLUENCE_404' }, probe: async () => { throw new Error('must not probe'); } });
  assert.equal((await resolveVaultTier(d)).tier, 'OBJECT_STORE');
  assert.equal(await rememberedVaultTier(d), 'OBJECT_STORE');
});

test('a site with a vault space is a Confluence site, remembered', async () => {
  const d = deps({ site: { space_id: 's1' } });
  const tier = await resolveVaultTier(d);
  assert.equal(tier.tier, 'CONFLUENCE');
  assert.deepEqual(d.saved[0][1], { tier: 'CONFLUENCE', reason: 'VAULT_SPACE_EXISTS', decidedAt: 5 });
  assert.equal(d.events[0].eventType, 'VAULT_TIER_DETECTED');
});

test('Confluence answering is CONFLUENCE, not remembered until the vault space exists', async () => {
  const d = deps();
  const tier = await resolveVaultTier(d);
  assert.equal(tier.tier, 'CONFLUENCE');
  assert.equal(tier.remembered, false);
  assert.deepEqual(d.saved, []);
});

test('no Confluence on the site is OBJECT_STORE, remembered', async () => {
  for (const status of [401, 403, 404]) {
    const d = deps({ probe: async () => ({ ok: false, status }) });
    const tier = await resolveVaultTier(d);
    assert.equal(tier.tier, 'OBJECT_STORE');
    assert.equal(d.saved[0][1].reason, `NO_CONFLUENCE_${status}`);
  }
});

test('a request that fails outright vaults to the Object Store now, and asks again next time', async () => {
  const d = deps({ probe: async () => { throw new Error('no such product'); } });
  const tier = await resolveVaultTier(d);
  assert.equal(tier.tier, 'OBJECT_STORE');
  assert.equal(tier.remembered, false);
  assert.deepEqual(d.saved, []);
});

test('Confluence being down is thrown for the queue to retry, and nothing is remembered', async () => {
  for (const status of [500, 503, 429]) {
    const d = deps({ probe: async () => ({ ok: false, status }) });
    await assert.rejects(() => resolveVaultTier(d), error => error.status === 503);
    assert.deepEqual(d.saved, []);
  }
});
