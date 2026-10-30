/**
 * Share a created-object ledger across setup scripts.
 *
 * Record each new ID immediately in .out/state.<host>.json. Later runs reuse
 * those IDs. Stop on name clashes with objects outside the ledger rather than
 * adopting objects this setup did not create.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT = join(dirname(fileURLToPath(import.meta.url)), '.out');

export const pending = (kind, name) => `<new ${kind} "${name}">`;
export const isPending = (id) => typeof id === 'string' && id.startsWith('<new ');

export function openLedger(jira, { apply, log = console.log }) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `state.${new URL(jira.site).hostname}.json`);
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { site: jira.site, created: [] };

  const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
  const createdId = (kind, name) => state.created.find((c) => c.kind === kind && c.name === name)?.id ?? null;
  function record(kind, id, name, extra = {}) {
    state.created.push({ kind, id: String(id), name, at: new Date().toISOString(), ...extra });
    save();
  }

  /**
   * Find-or-create. `existing` returns the site object with this name, or null.
   * Ours (in the ledger) → reuse. Someone else's object → stop, unless it is
   * reusable by design (`allowForeign`) → reference it, never modify it.
   */
  async function ensure(kind, name, { existing, create, allowForeign = false }) {
    const mine = createdId(kind, name);
    const found = await existing();
    if (found) {
      const id = String(found.id);
      if (mine && mine === id) { log(`  ok      ${kind} "${name}" (${id}, created earlier by this setup)`); return id; }
      if (allowForeign) { log(`  reuse   ${kind} "${name}" (${id}, existing, referenced without changes)`); return id; }
      throw new Error(`${kind} "${name}" already exists (${id}) but this setup did not create it. Stopping rather than adopting it.`);
    }
    if (mine) throw new Error(`${kind} "${name}" is in the ledger (${mine}) but no longer on the site. Resolve by hand before re-running.`);
    if (!apply) { log(`  CREATE  ${kind} "${name}"`); return pending(kind, name); }
    const id = String(await create());
    record(kind, id, name);
    log(`  created ${kind} "${name}" (${id})`);
    return id;
  }

  return { file, state, createdId, record, ensure };
}
