# VAtlassian P0 Correctness Implementation Plan

**Goal:** Fix every defect in the 2026-09-07 audit that is wrong under *both* the `STRICT` and `DETECT` operating models, so the locking architecture in Plan 2 is built on a restore path that cannot silently lie.

**Architecture:** Nine independent tasks against the existing Forge app. Pure decision logic goes in modules with no I/O (matching `lib/decision.js`, `lib/interception.js`); anything importing `@forge/api` stays a thin shell so tests can reach the rules without a Forge runtime. Two new SQL migrations (`v021`, `v022`) append to the existing consolidated set. No new dependencies, no egress.

**Tech Stack:** Node 22 ESM, `node --test`, Forge SQL (MySQL), `@forge/api`, `@forge/resolver`, React 18 + Vite for `frontend/`.

**Spec:** `docs/AUDIT-2026-09-07.md`

## Global Constraints

- **Zero egress.** No `remotes:` and no `permissions.external` may appear in `manifest.yml`. `test/manifest-lint.test.js` asserts this; never weaken it.
- **No new runtime dependencies.** `package.json` dependencies stay exactly as they are.
- **Migrations are append-only.** Existing ids `v001`–`v020` are frozen. New entries append to the end of the array in `src/db/migrations.js` and must be `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE`-tolerant.
- **Fail closed.** Where a control cannot be evaluated, refuse. Never downgrade an assurance requirement, never report a restore verified that was not re-read.
- **Restore success is derived only from a post-write verification read.** A 204 from Jira is not evidence.
- **The signed content hash is immutable.** No code path may substitute a freshly computed hash for the hash a reviewer signed.
- **Minimum assurance floor is `ESIGNATURE`.** Server-enforced; configuration may raise it, never lower it.
- Run `npm test` (currently 453 tests) after every task. Green means 0 failures, not "only the known one".
- Commit after every task. Repo was initialised at `872d1db`.

---

### Task 1: Green the build and retire the applied scratch scripts

The suite is red on `test/manifest-lint.test.js`. `fix_manifest.js` rewrote `manifest.yml` and the YAML round-trip produced `experience: [ issue-view ]` (spaces inside brackets) while the test substring-matches `experience: [issue-view]`. The manifest is semantically correct; the test is brittle. Four scratch scripts in the repo root have already been applied to the tree and are now dead weight that a future reader will mistake for pending work.

**Files:**
- Modify: `test/manifest-lint.test.js:11-16`
- Delete: `fix_manifest.js`, `manifest.patch`, `manifest.yml.orig`, `patch_drift.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a green `npm test` baseline every later task depends on.

- [ ] **Step 1: Confirm the failure and that it is cosmetic**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 453`, `pass 452`, `fail 1`.

Run: `grep -n "experience" manifest.yml`
Expected: two lines, `experience: [ issue-view ]` and `experience: [ issue-transition ]` — spaces inside the brackets. This confirms the manifest is right and the assertion is the problem.

- [ ] **Step 2: Rewrite the assertion to normalise inline-sequence whitespace**

Replace the second test in `test/manifest-lint.test.js` with:

```js
test('manifest.yml edit.experience array must be exactly issue-transition or issue-view', () => {
  const manifest = fs.readFileSync('manifest.yml', 'utf8');
  // YAML inline sequences are whitespace-insensitive: `[a]`, `[ a ]` and
  // `[ a, b ]` are the same document. The previous substring match asserted a
  // formatting choice, so a harmless reformat of manifest.yml turned the suite
  // red while the app was correct. Normalise, then assert the content.
  const inline = manifest
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\s*,\s*/g, ',');
  assert.equal(inline.includes('experience: [issue-view]'), true, 'experience must contain issue-view');
  assert.equal(inline.includes('experience: [issue-transition]'), true, 'experience must contain issue-transition');
});
```

- [ ] **Step 3: Run the suite to verify it is green**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `pass 453`, `fail 0`.

- [ ] **Step 4: Verify the scratch scripts are already applied, then delete them**

Run each check and confirm the expected output before deleting anything:

```bash
grep -c "resolver:" manifest.yml                      # expect 5 — fix_manifest.js applied
                                                      # (va-authenticator, va-approval-field,
                                                      #  va-gate, va-admin, va-admin-configure)
grep -c "CAPTURE_DISABLED" src/usecases/drift.js      # expect 1 — patch_drift.js applied
diff <(grep -c "" manifest.yml.orig) <(grep -c "" manifest.yml)  # differ; .orig is the pre-patch copy
```

Then:

```bash
rm fix_manifest.js manifest.patch manifest.yml.orig patch_drift.js
```

- [ ] **Step 5: Run the suite again and commit**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `pass 453`, `fail 0`.

```bash
git add -A
git commit -m "fix: make manifest lint whitespace-insensitive and drop applied scratch scripts"
```

---

### Task 2: Explicit field adapters for restore writes

`writeShape` in `src/lib/restore/planner.js:44` switches on `editmeta[fieldId].schema.type`. Jira REST v3 reports `description` and `environment` as `{ type: 'string', system: 'description' }` even though the API accepts and returns an ADF document, so an ADF baseline value falls into the `string` branch and is written as the literal text `"[object Object]"`. `option-with-child` returns `idOf(value, 'id')`, which drops the child selection.

Both reproduced against the current code:

```
description -> "[object Object]"
cascading   -> {"id":"10"}
```

**Files:**
- Create: `src/lib/restore/adapters.js`
- Modify: `src/lib/restore/planner.js:26-107` (delegate `writeShape` to the registry)
- Test: `test/restore-adapters.test.js`

**Interfaces:**
- Consumes: `FIELD_KIND` from `src/lib/content.js`.
- Produces:
  - `ADAPTER_VERSION: number` (currently `1`)
  - `isAdfField({ field, schema }): boolean`
  - `shapeFor({ field, value, editmeta }): { ok: boolean, value: any, adapter: string, reason: string|null }`
  - `writeShape({ field, value, editmeta }): any` stays exported from `planner.js` and returns `shapeFor(...).value`, so `test/baseline-restore.test.js` keeps passing unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/restore-adapters.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeFor, isAdfField, ADAPTER_VERSION } from '../src/lib/restore/adapters.js';
import { FIELD_KIND } from '../src/lib/content.js';

const ADF = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'approved' }] }] };

test('description is ADF even though v3 editmeta calls it a string', () => {
  const editmeta = { description: { schema: { type: 'string', system: 'description' } } };
  const result = shapeFor({ field: { field_id: 'description', field_kind: FIELD_KIND.ADF }, value: ADF, editmeta });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, 'adf');
  assert.deepEqual(result.value, ADF, 'the document must be written verbatim, not stringified');
});

test('environment is ADF', () => {
  const editmeta = { environment: { schema: { type: 'string', system: 'environment' } } };
  const result = shapeFor({ field: { field_id: 'environment', field_kind: FIELD_KIND.ADF }, value: ADF, editmeta });
  assert.deepEqual(result.value, ADF);
});

test('a textarea custom field is ADF', () => {
  const schema = { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' };
  assert.equal(isAdfField({ field: { field_id: 'customfield_1' }, schema }), true);
});

test('a plain text custom field is not ADF', () => {
  const schema = { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' };
  assert.equal(isAdfField({ field: { field_id: 'customfield_2' }, schema }), false);
});

test('cascading select preserves the child option', () => {
  const editmeta = { customfield_100: { schema: { type: 'option-with-child' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_100', field_kind: FIELD_KIND.SCALAR },
    value: { id: '10', value: 'Parent', child: { id: '20', value: 'Child' } },
    editmeta
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { id: '10', child: { id: '20' } });
});

test('cascading select with no child writes the parent alone', () => {
  const editmeta = { customfield_100: { schema: { type: 'option-with-child' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_100', field_kind: FIELD_KIND.SCALAR },
    value: { id: '10', value: 'Parent' },
    editmeta
  });
  assert.deepEqual(result.value, { id: '10' });
});

test('cascading select with an unresolvable child refuses rather than dropping it', () => {
  const editmeta = { customfield_100: { schema: { type: 'option-with-child' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_100', field_kind: FIELD_KIND.SCALAR },
    value: { id: '10', child: { value: 'Child with no id' } },
    editmeta
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /child/i);
});

test('a structured value against a genuine string field refuses instead of stringifying', () => {
  const editmeta = { customfield_3: { schema: { type: 'string', custom: 'x:textfield' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_3', field_kind: FIELD_KIND.TEXT },
    value: { unexpected: 'object' },
    editmeta
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.value, '[object Object]');
});

test('users write as accountId objects', () => {
  const editmeta = { assignee: { schema: { type: 'user' } } };
  const result = shapeFor({
    field: { field_id: 'assignee', field_kind: FIELD_KIND.SCALAR },
    value: { accountId: 'abc', displayName: 'Ada' },
    editmeta
  });
  assert.deepEqual(result.value, { accountId: 'abc' });
});

test('multi-user arrays write as accountId objects', () => {
  const editmeta = { customfield_4: { schema: { type: 'array', items: 'user' } } };
  const result = shapeFor({
    field: { field_id: 'customfield_4', field_kind: FIELD_KIND.MULTI },
    value: [{ accountId: 'a' }, { accountId: 'b' }],
    editmeta
  });
  assert.deepEqual(result.value, [{ accountId: 'a' }, { accountId: 'b' }]);
});

test('versions and components write as id objects', () => {
  const editmeta = { fixVersions: { schema: { type: 'array', items: 'version' } } };
  const result = shapeFor({
    field: { field_id: 'fixVersions', field_kind: FIELD_KIND.MULTI },
    value: [{ id: '1', name: '1.0' }],
    editmeta
  });
  assert.deepEqual(result.value, [{ id: '1' }]);
});

test('an explicit null clears a scalar and an empty array clears a multi', () => {
  const editmeta = { duedate: { schema: { type: 'date' } }, labels: { schema: { type: 'array', items: 'string' } } };
  assert.equal(shapeFor({ field: { field_id: 'duedate' }, value: null, editmeta }).value, null);
  assert.deepEqual(shapeFor({ field: { field_id: 'labels' }, value: null, editmeta }).value, []);
});

test('an ADF field with a null baseline value clears rather than refusing', () => {
  const editmeta = { description: { schema: { type: 'string', system: 'description' } } };
  const result = shapeFor({ field: { field_id: 'description', field_kind: FIELD_KIND.ADF }, value: null, editmeta });
  assert.equal(result.ok, true);
  assert.equal(result.value, null);
});

test('the adapter version is exported so a restore can record which rules ran', () => {
  assert.equal(typeof ADAPTER_VERSION, 'number');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/restore-adapters.test.js`
Expected: FAIL — `Cannot find module '../src/lib/restore/adapters.js'`.

- [ ] **Step 3: Write the adapter registry**

Create `src/lib/restore/adapters.js`:

```js
import { FIELD_KIND } from '../content.js';

/**
 * How a baselined value is turned into something Jira will accept on
 * PUT /rest/api/3/issue/{key}.
 *
 * WHY THIS IS NOT A SWITCH ON schema.type. Jira REST v3 reports `description`
 * and `environment` as `{ type: 'string', system: 'description' }` while
 * accepting and returning an ADF document. A generic string branch therefore
 * stringifies the approved document into the literal text "[object Object]"
 * and writes that into the field — a restore that destroys the record it was
 * asked to protect. Field IDENTITY decides the adapter; the schema only
 * refines it.
 *
 * REFUSING IS A RESULT. Every adapter returns { ok, value, adapter, reason }.
 * A lossy coercion is never performed silently: the planner turns `ok: false`
 * into a named "cannot be restored" entry that the reviewer sees BEFORE they
 * confirm, which is the same contract lib/diff/fields.js already keeps for
 * irreversible and unretained fields.
 *
 * Pure. No I/O, no clock, no database.
 */

/** Bumped whenever these rules change, so a restore can record which ran. */
export const ADAPTER_VERSION = 1;

const ADF_SYSTEM_FIELDS = new Set(['description', 'environment']);
const ADF_CUSTOM_SUFFIXES = [':textarea'];

export function isAdfField({ field, schema }) {
  if (field?.field_kind === FIELD_KIND.ADF) return true;
  if (schema?.type === 'doc') return true;
  if (schema?.system && ADF_SYSTEM_FIELDS.has(schema.system)) return true;
  if (typeof schema?.custom === 'string'
      && ADF_CUSTOM_SUFFIXES.some((s) => schema.custom.endsWith(s))) return true;
  return false;
}

const ok = (value, adapter) => ({ ok: true, value, adapter, reason: null });
const refuse = (adapter, reason) => ({ ok: false, value: null, adapter, reason });

export function shapeFor({ field, value, editmeta = {} }) {
  const meta = editmeta?.[field.field_id];
  const schema = meta?.schema ?? { type: inferType(field.field_kind) };
  const { type, items } = schema;

  // ── ADF first, before any schema.type dispatch ───────────────────────────
  if (isAdfField({ field, schema })) {
    if (value === null || value === undefined) return ok(null, 'adf');
    if (typeof value !== 'object') {
      return refuse('adf', 'The approved value for this rich-text field was not stored as a document, so writing it back would change its formatting. Restore it by hand from the diff.');
    }
    // Verbatim. Writing a normalised document back would strip the localIds
    // Jira put there and count as a second edit.
    return ok(value, 'adf');
  }

  if (value === null || value === undefined) {
    // Jira accepts null for most fields and an empty array for multi-valued
    // ones; sending null to an array field is a 400.
    return ok(type === 'array' ? [] : null, 'clear');
  }

  switch (type) {
    case 'string':
      if (typeof value === 'string') return ok(value, 'string');
      if (typeof value === 'number' || typeof value === 'boolean') return ok(String(value), 'string');
      return refuse('string', 'Jira reports this field as plain text but the approved value is a structured value. Writing it would store a placeholder instead of the content.');

    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return refuse('number', 'The approved value is not a number Jira will accept.');
      return ok(n, 'number');
    }

    case 'date':
      // YYYY-MM-DD. An ISO datetime is rejected by a date field.
      if (typeof value !== 'string') return refuse('date', 'The approved value is not a date Jira will accept.');
      return ok(value.slice(0, 10), 'date');

    case 'datetime':
      if (typeof value !== 'string') return refuse('datetime', 'The approved value is not a timestamp Jira will accept.');
      return ok(value, 'datetime');

    case 'user': {
      const id = idOf(value, 'accountId');
      return id == null
        ? refuse('user', 'The approved value does not carry an account id, so the user cannot be identified.')
        : ok(id, 'user');
    }

    case 'option-with-child': {
      const parent = idOf(value, 'id');
      if (parent == null) return refuse('cascading', 'The approved value does not carry an option id.');
      const hasChild = value && typeof value === 'object' && value.child != null;
      if (!hasChild) return ok(parent, 'cascading');
      const childId = value.child?.id ?? null;
      if (childId == null) {
        return refuse('cascading', 'The approved value records a child option with no id, so restoring the parent alone would silently lose the second selection.');
      }
      return ok({ ...parent, child: { id: String(childId) } }, 'cascading');
    }

    case 'priority':
    case 'resolution':
    case 'issuetype':
    case 'securitylevel':
    case 'option': {
      const id = idOf(value, 'id');
      return id == null
        ? refuse('option', 'The approved value does not carry an option id.')
        : ok(id, 'option');
    }

    case 'timetracking':
      return ok({
        originalEstimate: value.originalEstimate ?? undefined,
        remainingEstimate: value.remainingEstimate ?? undefined
      }, 'timetracking');

    case 'array': {
      const arr = Array.isArray(value) ? value : [value];
      // Labels are bare strings; everything else entity-backed wants ids.
      if (items === 'string' || field.field_id === 'labels') return ok(arr.map(String), 'labels');
      const key = items === 'user' ? 'accountId' : 'id';
      const mapped = arr.map((v) => idOf(v, key));
      if (mapped.some((v) => v == null)) {
        return refuse('array', `One or more approved entries do not carry ${key === 'user' ? 'an account id' : 'an id'}, so the list cannot be restored exactly.`);
      }
      return ok(mapped, key === 'accountId' ? 'multi-user' : 'multi-entity');
    }

    default:
      // An unrecognised schema is written as-is. It may fail, and if it does
      // the executor's per-field retry reports exactly which field and why,
      // which is more useful than refusing to try.
      return ok(value, 'passthrough');
  }
}

function inferType(kind) {
  switch (kind) {
    case FIELD_KIND.ADF: return 'doc';
    case FIELD_KIND.TEXT: return 'string';
    case FIELD_KIND.MULTI: return 'array';
    default: return 'string';
  }
}

function idOf(value, key) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const id = value[key] ?? value.id ?? value.value ?? value.key;
    return id == null ? null : { [key]: String(id) };
  }
  return { [key]: String(value) };
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `node --test test/restore-adapters.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Delegate `writeShape` in the planner to the registry**

In `src/lib/restore/planner.js`, replace the whole `writeShape` function and its `inferType`/`idOf` helpers (lines 18–107) with:

```js
/**
 * How each field kind is written back to Jira.
 *
 * The rules live in ./adapters.js so they can be tested exhaustively without
 * the planner, and so field IDENTITY — not just `schema.type` — decides the
 * adapter. See that module's header for why the previous schema-type switch
 * wrote "[object Object]" into description fields.
 *
 * Kept as a named export returning the bare value because existing callers and
 * test/baseline-restore.test.js read it that way. New code should call
 * `shapeFor` and honour `ok: false`.
 */
export function writeShape({ field, value, editmeta }) {
  return shapeFor({ field, value, editmeta }).value;
}
```

And add to the imports at the top of the file:

```js
import { shapeFor, ADAPTER_VERSION } from './adapters.js';
```

Re-export the version so `restoreActions.js` can record it without a second import path:

```js
export { ADAPTER_VERSION };
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. `test/baseline-restore.test.js` still passes because `writeShape` keeps its old signature and return type.

- [ ] **Step 7: Commit**

```bash
git add src/lib/restore/adapters.js src/lib/restore/planner.js test/restore-adapters.test.js
git commit -m "fix: explicit restore field adapters; ADF no longer stringified, cascading child preserved"
```

---

### Task 3: The planner restores every tracked difference

`src/lib/restore/planner.js:136` skips any field whose `semanticChange` is false. `diff.fields` only ever contains fields whose *normalised* value changed (`src/lib/diff/index.js:87` drops the rest), so every entry in that list is genuine integrity drift. A tracked text field edited from `"hello"` to `"  hello"` has `changed: true` and `semanticChange: false` (`src/lib/diff/fields.js:140`): it is recorded as drift, never restored, and — because the verifier only inspects fields the executor attempted — the restore reports `COMPLETE` with the field still wrong.

Integrity and presentation must be separate: the summary may say "formatting only"; the restore may not skip it.

**Files:**
- Modify: `src/lib/restore/planner.js:123-215`
- Test: `test/baseline-restore.test.js` (add cases)

**Interfaces:**
- Consumes: `shapeFor`, `ADAPTER_VERSION` from Task 2.
- Produces: `planRestore(...)` gains `preflight.formattingOnly: string[]` and `adapterVersion: number`. `steps[].restorable` may now be `RESTORABLE.NO` with an adapter-supplied `reason` when `shapeFor` refuses.

- [ ] **Step 1: Write the failing tests**

Append to `test/baseline-restore.test.js`:

```js
test('a formatting-only difference is still restored', () => {
  const plan = planRestore({
    diff: {
      issueId: 1, baselineId: 'b', baselineVersion: 1,
      fields: [{
        fieldId: 'summary', fieldName: 'Summary',
        changed: true, semanticChange: false,
        restorable: RESTORABLE.YES, restorableReason: null
      }]
    },
    baselineValues: { summary: 'hello' },
    controlledFields: [{ field_id: 'summary', field_kind: FIELD_KIND.TEXT }],
    editmeta: { summary: { schema: { type: 'string' } } }
  });
  assert.equal(plan.fieldWrites.summary, 'hello', 'integrity drift must be written back even when the diff calls it cosmetic');
  assert.deepEqual(plan.preflight.formattingOnly, ['Summary']);
  assert.equal(plan.steps.length, 1);
});

test('the summary still tells the reviewer a change was formatting only', () => {
  const plan = planRestore({
    diff: {
      issueId: 1, baselineId: 'b', baselineVersion: 1,
      fields: [{
        fieldId: 'summary', fieldName: 'Summary',
        changed: true, semanticChange: false,
        restorable: RESTORABLE.YES, restorableReason: null
      }]
    },
    baselineValues: { summary: 'hello' },
    controlledFields: [{ field_id: 'summary', field_kind: FIELD_KIND.TEXT }],
    editmeta: { summary: { schema: { type: 'string' } } }
  });
  assert.match(plan.summary, /formatting/i);
});

test('an adapter refusal becomes a named cannot-restore rather than a bad write', () => {
  const plan = planRestore({
    diff: {
      issueId: 1, baselineId: 'b', baselineVersion: 1,
      fields: [{
        fieldId: 'customfield_9', fieldName: 'Odd field',
        changed: true, semanticChange: true,
        restorable: RESTORABLE.YES, restorableReason: null
      }]
    },
    baselineValues: { customfield_9: { some: 'object' } },
    controlledFields: [{ field_id: 'customfield_9', field_kind: FIELD_KIND.TEXT }],
    editmeta: { customfield_9: { schema: { type: 'string', custom: 'x:textfield' } } }
  });
  assert.equal(plan.fieldWrites.customfield_9, undefined, 'a refused shape must never reach the PUT payload');
  assert.equal(plan.steps[0].strategy, 'none');
  assert.equal(plan.preflight.cannotRestore.length, 1);
  assert.match(plan.preflight.cannotRestore[0].reason, /plain text/i);
});

test('the plan records which adapter version produced it', () => {
  const plan = planRestore({ diff: { issueId: 1, baselineId: 'b', baselineVersion: 1, fields: [] } });
  assert.equal(typeof plan.adapterVersion, 'number');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/baseline-restore.test.js`
Expected: FAIL — `plan.fieldWrites.summary` is `undefined` (the field was skipped) and `plan.preflight.formattingOnly` is `undefined`.

- [ ] **Step 3: Rewrite `planRestore`'s loop**

In `src/lib/restore/planner.js`, replace the body of `planRestore` (the `for` loop and the `return`) with:

```js
export function planRestore({ diff, baselineValues = {}, controlledFields = [], editmeta = {} }) {
  const byId = new Map(controlledFields.map((f) => [f.field_id, f]));
  const steps = [];
  const fieldWrites = {};

  const willRestore = [];
  const needsHandler = [];
  const cannotRestore = [];
  const formattingOnly = [];

  for (const fieldDiff of diff.fields) {
    // EVERY entry in diff.fields is integrity drift: lib/diff/index.js only
    // pushes a field whose normalised value differs from the baseline. A
    // formatting-only change is still a change to the record, so it is still
    // restored — `semanticChange` decides what the reviewer is TOLD, never
    // what is written. Skipping here is how a restore reported COMPLETE while
    // a tracked field was still wrong.
    if (fieldDiff.changed === false) continue;
    if (fieldDiff.semanticChange === false) formattingOnly.push(fieldDiff.fieldName);

    const field = byId.get(fieldDiff.fieldId);
    if (!field) continue;

    const restorable = fieldDiff.restorable;
    const reason = fieldDiff.restorableReason;
    const handler = specialHandlerFor(fieldDiff.fieldId);

    if (restorable === RESTORABLE.NO || restorable === RESTORABLE.NOT_RETAINED) {
      steps.push({
        fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
        strategy: 'none', targetValue: null, restorable, reason
      });
      cannotRestore.push({ fieldName: fieldDiff.fieldName, reason });
      continue;
    }

    // The RAW stored value, not the normalised one the differ compared:
    // normalisation sorts multi-values and strips ADF node ids, so writing the
    // normalised form back would be a silent, uninvited second edit.
    const target = baselineValues[fieldDiff.fieldId];

    if (handler) {
      steps.push({
        fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
        strategy: handler, targetValue: target,
        restorable: RESTORABLE.SPECIAL, reason
      });
      needsHandler.push(fieldDiff.fieldName);
      continue;
    }

    const shaped = shapeFor({ field, value: target, editmeta });
    if (!shaped.ok) {
      // The adapter refused rather than coercing. Named here so the reviewer
      // reads it in the confirmation dialog, not afterwards in a failure list.
      steps.push({
        fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
        strategy: 'none', targetValue: null,
        restorable: RESTORABLE.NO, reason: shaped.reason
      });
      cannotRestore.push({ fieldName: fieldDiff.fieldName, reason: shaped.reason });
      continue;
    }

    fieldWrites[fieldDiff.fieldId] = shaped.value;
    steps.push({
      fieldId: fieldDiff.fieldId, fieldName: fieldDiff.fieldName,
      strategy: 'field', targetValue: shaped.value,
      restorable: RESTORABLE.YES, reason: null, adapter: shaped.adapter
    });
    willRestore.push(fieldDiff.fieldName);
  }

  return {
    issueId: diff.issueId,
    baselineId: diff.baselineId,
    baselineVersion: diff.baselineVersion,
    adapterVersion: ADAPTER_VERSION,
    steps,
    fieldWrites,
    preflight: { willRestore, needsHandler, cannotRestore, formattingOnly },
    summary: describePlan(willRestore, needsHandler, cannotRestore, formattingOnly)
  };
}
```

And replace `describePlan`:

```js
function describePlan(willRestore, needsHandler, cannotRestore, formattingOnly = []) {
  const parts = [];
  const restorable = willRestore.length + needsHandler.length;
  if (restorable > 0) {
    parts.push(`${restorable} field${restorable === 1 ? '' : 's'} will be returned to the approved value`);
  }
  if (formattingOnly.length > 0) {
    // Said out loud rather than silently skipped. The field IS being written —
    // the reviewer just deserves to know the visible difference is small.
    parts.push(`${formattingOnly.length} of them differ only in formatting`);
  }
  if (cannotRestore.length > 0) {
    parts.push(`${cannotRestore.length} cannot be restored`);
  }
  if (parts.length === 0) return 'Nothing to restore — this work item matches its approved values.';
  return `${parts.join(', ')}.`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/baseline-restore.test.js`
Expected: PASS, including the four new cases.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. If `test/baseline-diff.test.js` or a panel test asserts the old "every change is formatting only" summary string, update that assertion to the new copy — the behaviour change is intended.

- [ ] **Step 6: Commit**

```bash
git add src/lib/restore/planner.js test/baseline-restore.test.js
git commit -m "fix: restore every tracked difference; formatting-only drives wording, not skipping"
```

---

### Task 4: Verify the whole tracked baseline, not just attempted writes

`src/lib/restore/verifier.js:64` returns early for any field whose outcome is not `SUCCEEDED`, so a tracked field that was never written — or that a workflow post-function changed *during* the restore — is never compared. `tally` then reports `COMPLETE`, `markDecided` clears the drift and `release` sets the item to `BASELINED`.

Completion must mean the entire tracked projection matches.

**Files:**
- Modify: `src/lib/restore/verifier.js:39-82`
- Modify: `src/lib/restore/outcome.js:56-80` (`tally` signature)
- Modify: `src/usecases/restoreActions.js:20-27`
- Test: `test/restore-verification.test.js`

**Interfaces:**
- Consumes: `project()` from `src/lib/content.js`, `OUTCOME`/`RESTORE_STATE` from `outcome.js`.
- Produces:
  - `verifyRestore({...}): Promise<{ detail: Detail[], unmatched: { fieldId, fieldName, expected, actual }[] }>` — **breaking change**, it previously returned `detail` directly.
  - `tally(detail, unmatched = []): { counters, state }` where `counters` gains `unmatched: number` and `state` can never be `COMPLETE` while `unmatched.length > 0`.
  - `describeResult({ counters, state })` mentions unmatched fields.

- [ ] **Step 1: Write the failing test**

Create `test/restore-verification.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { tally, OUTCOME, RESTORE_STATE } from '../src/lib/restore/outcome.js';

test('a verified write with no unmatched fields is COMPLETE', () => {
  const { counters, state } = tally(
    [{ fieldId: 'summary', outcome: OUTCOME.SUCCEEDED, verified: true }],
    []
  );
  assert.equal(state, RESTORE_STATE.COMPLETE);
  assert.equal(counters.unmatched, 0);
});

test('a tracked field that still does not match blocks COMPLETE', () => {
  const { counters, state } = tally(
    [{ fieldId: 'summary', outcome: OUTCOME.SUCCEEDED, verified: true }],
    [{ fieldId: 'duedate', fieldName: 'Due date', expected: 'a', actual: 'b' }]
  );
  assert.notEqual(state, RESTORE_STATE.COMPLETE);
  assert.equal(state, RESTORE_STATE.PARTIAL);
  assert.equal(counters.unmatched, 1);
});

test('unmatched fields alone, with nothing written, is not COMPLETE either', () => {
  const { state } = tally([], [{ fieldId: 'x', fieldName: 'X', expected: 'a', actual: 'b' }]);
  assert.notEqual(state, RESTORE_STATE.COMPLETE);
});

test('tally without an unmatched argument keeps the old behaviour', () => {
  const { state } = tally([{ fieldId: 's', outcome: OUTCOME.SUCCEEDED, verified: true }]);
  assert.equal(state, RESTORE_STATE.COMPLETE);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/restore-verification.test.js`
Expected: FAIL — the second test gets `COMPLETE` because `tally` ignores its second argument, and `counters.unmatched` is `undefined`.

- [ ] **Step 3: Extend `tally`**

In `src/lib/restore/outcome.js`, replace `tally`:

```js
/**
 * Roll per-field outcomes into the counters va_restore stores.
 *
 * A FIELD THAT WAS WRITTEN BUT NOT VERIFIED COUNTS AS FAILED. There is
 * deliberately no third category: the whole value of the verification pass is
 * that "succeeded" means something.
 *
 * `unmatched` carries fields the verifier re-read and found NOT equal to the
 * baseline, whether or not this restore tried to write them. A tracked field a
 * post-function rewrote mid-restore lands here, and it is why COMPLETE cannot
 * be derived from the write outcomes alone: "complete" has to mean the whole
 * tracked projection matches, not that every attempt succeeded.
 */
export function tally(detail, unmatched = []) {
  const counters = {
    attempted: detail.length, succeeded: 0, failed: 0, skipped: 0,
    irreversible: 0, unmatched: unmatched.length
  };
  for (const d of detail) {
    if (d.outcome === OUTCOME.SUCCEEDED && d.verified) counters.succeeded++;
    else if (d.outcome === OUTCOME.IRREVERSIBLE) counters.irreversible++;
    else if (d.outcome === OUTCOME.SKIPPED) counters.skipped++;
    else counters.failed++;
  }

  let state = counters.failed > 0
    ? (counters.succeeded > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.FAILED)
    : (counters.irreversible > 0 || counters.skipped > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.COMPLETE);

  // The whole-baseline gate. Nothing else in this file may promote a state to
  // COMPLETE, and this may only demote.
  if (counters.unmatched > 0 && state === RESTORE_STATE.COMPLETE) {
    state = counters.succeeded > 0 ? RESTORE_STATE.PARTIAL : RESTORE_STATE.FAILED;
  }

  return { counters, state };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/restore-verification.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Make the verifier compare the whole baseline**

In `src/lib/restore/verifier.js`, replace `verifyRestore`:

```js
export async function verifyRestore({ api, issueKey, controlledFields, baselineDigests, detail }) {
  let current;
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=*all`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    current = body.fields ?? {};
  } catch (e) {
    console.error('restore: verification read failed', issueKey, e);
    // Deliberately pessimistic. An unverifiable restore reported as complete is
    // the one outcome this module exists to prevent. `unmatched` carries a
    // sentinel so tally() cannot reach COMPLETE on an unread issue either.
    return {
      detail: detail.map((d) => (
        d.outcome === OUTCOME.SUCCEEDED
          ? {
              ...d, outcome: OUTCOME.FAILED, verified: false,
              reason: 'The work item could not be re-read, so this restore could not be confirmed. Nothing is known to have failed — but nothing is confirmed either.'
            }
          : { ...d, verified: false }
      )),
      unmatched: [{ fieldId: null, fieldName: 'the work item', expected: null, actual: null,
        reason: 'The work item could not be re-read, so no field could be confirmed.' }]
    };
  }

  const { digests } = project(current, controlledFields);

  const verified = detail.map((d) => {
    if (d.outcome !== OUTCOME.SUCCEEDED) return { ...d, verified: false };

    const expected = baselineDigests?.[d.fieldId] ?? null;
    const actual = digests?.[d.fieldId] ?? null;
    if (expected != null && actual === expected) return { ...d, verified: true };

    return {
      ...d, outcome: OUTCOME.FAILED, verified: false,
      reason: expected == null
        ? 'No approved digest was recorded for this field, so the restore cannot be confirmed.'
        : 'Jira accepted the write but the field does not match the approved value. A screen configuration or a workflow post-function may be overriding it.'
    };
  });

  // ── The whole tracked projection, not just what we tried to write ─────────
  //
  // A field this restore never touched can still be wrong: a post-function or
  // a concurrent edit can change it between the plan and the re-read. Checking
  // only attempted writes is how "restore complete" came to mean "every write
  // we attempted landed", which is a different and much weaker claim.
  const byId = new Map(controlledFields.map((f) => [f.field_id, f]));
  const unmatched = [];
  for (const [fieldId, expected] of Object.entries(baselineDigests ?? {})) {
    const field = byId.get(fieldId);
    if (!field) continue;                       // no longer tracked; not this restore's business
    const actual = digests?.[fieldId] ?? null;
    if (actual === expected) continue;
    unmatched.push({
      fieldId,
      fieldName: field.field_name ?? fieldId,
      expected,
      actual,
      reason: 'This tracked field does not match its approved value after the restore.'
    });
  }

  return { detail: verified, unmatched };
}
```

- [ ] **Step 6: Update `describeResult` to name the gap**

In the same file, insert before the `if (state === 'FAILED')` line in `describeResult`:

```js
  if (counters.unmatched > 0) {
    parts.push(`${counters.unmatched} tracked field${counters.unmatched === 1 ? ' still does' : 's still do'} not match the approved values`);
  }
```

- [ ] **Step 7: Update the caller**

In `src/usecases/restoreActions.js`, replace lines 21–27 (`const detail = await verifyRestore(...)` through `const { counters, state } = tally(detail);`) with:

```js
  const { detail, unmatched } = await verifyRestore({ api, issueKey: issue.key, controlledFields: fields,
    baselineDigests: typeof baseline.field_digests === 'string' ? JSON.parse(baseline.field_digests) : baseline.field_digests,
    detail: executed.detail });
  const { counters, state } = tally(detail, unmatched);
```

and add `unmatched` to the returned object and the ledger payload:

```js
  await tryAppend({ actorAccountId: actor.accountId, issueId, approvalId: approval.approval_id,
    eventType: state === 'COMPLETE' ? EVENT.RESTORE_COMPLETED : EVENT.RESTORE_PARTIAL,
    payload: { restoreId: restoreId.toString('base64'), state, counters,
      unmatched: unmatched.map((u) => u.fieldId) } });
  return { success: state === 'COMPLETE', restoreId, state, counters, detail, unmatched,
    message: describeResult({ counters, state }) };
```

- [ ] **Step 8: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. Any test calling `verifyRestore` and treating the result as an array must be updated to destructure `{ detail, unmatched }` — that is the intended breaking change.

- [ ] **Step 9: Commit**

```bash
git add src/lib/restore/verifier.js src/lib/restore/outcome.js src/usecases/restoreActions.js test/restore-verification.test.js
git commit -m "fix: verify the whole tracked baseline before declaring a restore complete"
```

---

### Task 5: A retry resumes the signed operation instead of re-signing today's content

`src/usecases/restore.js:25` calls `applyApproval({ approval: { ...approval, content_hash: prepared.contentHash } })`. `applyApproval` then compares `approval.content_hash` against a fresh read — comparing today's hash with itself. The signature's binding to specific content is discarded, which is precisely the substitution the spec forbids.

Removing the substitution alone makes every retry fail `STALE_EVIDENCE`, because a partially applied restore has by definition changed the content. The spec's rule is the fix: a retry is valid only when every tracked field currently holds **either** the signed candidate value **or** the baseline target value. Anything else is a third party's edit and requires a new review.

That needs the signed candidate's per-field digests to be durable, which also satisfies the audit's "capture the rejected candidate so restoration never erases the evidence of what was rejected."

**Files:**
- Create: `src/lib/restore/resume.js`
- Modify: `src/db/migrations.js` (append `v021_restore_candidate`)
- Modify: `src/db/restoreStore.js:47-63` (`startRestore`), and `RESTORE_COLUMNS`/`decode`
- Modify: `src/usecases/restoreActions.js:14-19`
- Modify: `src/usecases/restore.js:10-26`
- Test: `test/restore-resume.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resumable({ baselineDigests, candidateDigests, currentDigests }): { ok: boolean, reason: string|null, intruded: string[] }`.
  `startRestore` gains a `candidateDigests` argument (`{ fieldId: digest }`, defaulting to `{}`).
  `restoreById`/`restoresForIssue` rows gain `candidate_digests` — a parsed object, `{}` when the column is null or unparseable.

- [ ] **Step 1: Write the failing test**

Create `test/restore-resume.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resumable } from '../src/lib/restore/resume.js';

const baseline = { summary: 'B_SUM', duedate: 'B_DUE', labels: 'B_LAB' };
const candidate = { summary: 'C_SUM', duedate: 'C_DUE', labels: 'B_LAB' };

test('nothing moved since the signature: resumable', () => {
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: candidate });
  assert.equal(r.ok, true);
  assert.deepEqual(r.intruded, []);
});

test('a partially applied restore is resumable', () => {
  // summary already reverted to baseline, duedate still at the rejected value.
  const current = { summary: 'B_SUM', duedate: 'C_DUE', labels: 'B_LAB' };
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: current });
  assert.equal(r.ok, true);
});

test('a fully applied restore is resumable and idempotent', () => {
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: baseline });
  assert.equal(r.ok, true);
});

test('a third party edit to a tracked field is NOT resumable', () => {
  const current = { summary: 'B_SUM', duedate: 'SOMEBODY_ELSE', labels: 'B_LAB' };
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: current });
  assert.equal(r.ok, false);
  assert.deepEqual(r.intruded, ['duedate']);
  assert.equal(r.reason, 'NEW_EVIDENCE_REQUIRES_APPROVAL');
});

test('a tracked field missing from the current read is NOT resumable', () => {
  const current = { summary: 'B_SUM', labels: 'B_LAB' };
  const r = resumable({ baselineDigests: baseline, candidateDigests: candidate, currentDigests: current });
  assert.equal(r.ok, false);
  assert.deepEqual(r.intruded, ['duedate']);
});

test('a missing candidate snapshot refuses rather than guessing', () => {
  const r = resumable({ baselineDigests: baseline, candidateDigests: {}, currentDigests: baseline });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_SIGNED_CANDIDATE');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/restore-resume.test.js`
Expected: FAIL — `Cannot find module '../src/lib/restore/resume.js'`.

- [ ] **Step 3: Write the pure resume rule**

Create `src/lib/restore/resume.js`:

```js
/**
 * May a retry continue a signature that was given earlier?
 *
 * THE RULE. A reviewer signed a rejection of a specific candidate, to be
 * returned to a specific baseline. A retry may resume that signature only while
 * the work item is somewhere on the path between those two states — every
 * tracked field holding either the value they rejected or the value they
 * approved. Any third value means somebody edited the item after the signature
 * and the reviewer never saw it, so the signature no longer describes what
 * would be written.
 *
 * WHY NOT JUST RE-HASH. The previous implementation replaced the signed content
 * hash with a hash computed at retry time, which made the comparison vacuous —
 * it compared today's content with itself and always passed. A signature bound
 * to content it does not describe is not a signature.
 *
 * Pure. No I/O, no clock, no database.
 */

export function resumable({ baselineDigests = {}, candidateDigests = {}, currentDigests = {} }) {
  const candidateFields = Object.keys(candidateDigests);
  if (candidateFields.length === 0) {
    // No durable record of what was signed. Refusing is the only honest answer:
    // this restore predates candidate capture, or the row was written by an
    // older version, and a retry would be authorised by nothing.
    return { ok: false, reason: 'NO_SIGNED_CANDIDATE', intruded: [] };
  }

  const intruded = [];
  const tracked = new Set([...Object.keys(baselineDigests), ...candidateFields]);

  for (const fieldId of tracked) {
    const current = Object.prototype.hasOwnProperty.call(currentDigests, fieldId)
      ? currentDigests[fieldId]
      : undefined;
    // A field that vanished from the read is not "unchanged"; it is unknown,
    // and unknown fails closed.
    if (current === undefined) { intruded.push(fieldId); continue; }
    const permitted = [baselineDigests[fieldId], candidateDigests[fieldId]]
      .filter((d) => d !== undefined);
    if (!permitted.includes(current)) intruded.push(fieldId);
  }

  intruded.sort();
  return intruded.length === 0
    ? { ok: true, reason: null, intruded: [] }
    : { ok: false, reason: 'NEW_EVIDENCE_REQUIRES_APPROVAL', intruded };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/restore-resume.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Persist the signed candidate**

Append to the array in `src/db/migrations.js`, after `v020_write_suppression`:

```js
  // 2026-09-07: the rejected candidate's per-field digests, captured when the
  // restore starts. Two jobs: it is the evidence of WHAT was rejected, which a
  // successful restore would otherwise erase from the item; and it is what
  // lib/restore/resume.js needs to decide whether a retry may still resume the
  // reviewer's signature instead of silently re-signing today's content.
  { id: 'v021_restore_candidate', sql:
    `ALTER TABLE va_restore ADD COLUMN candidate_digests MEDIUMTEXT NULL` },
```

In `src/db/restoreStore.js`, extend `RESTORE_COLUMNS` and `decode`:

```js
const RESTORE_COLUMNS = `
  TO_BASE64(restore_id) AS restore_id, TO_BASE64(approval_id) AS approval_id,
  issue_id, project_id, TO_BASE64(baseline_id) AS baseline_id, baseline_version,
  actor_account_id, started_at, finished_at,
  attempted, succeeded, failed, skipped, irreversible, state, detail, candidate_digests
`;

function decode(row) {
  if (!row) return null;
  let detail = [];
  try {
    detail = row.detail ? JSON.parse(row.detail) : [];
  } catch {
    // A report whose detail will not parse still has meaningful counters, and
    // showing those with an empty breakdown is better than showing nothing.
    console.error('restore: unparseable detail for', row.restore_id);
  }
  let candidateDigests = {};
  try {
    candidateDigests = row.candidate_digests ? JSON.parse(row.candidate_digests) : {};
  } catch {
    // Unlike detail, this one has a consequence: lib/restore/resume.js treats an
    // empty candidate as NO_SIGNED_CANDIDATE and refuses the retry. Failing to
    // an empty object is therefore failing closed, which is what we want.
    console.error('restore: unparseable candidate digests for', row.restore_id);
  }
  return {
    ...row,
    restore_id: fromBinaryColumn(row.restore_id),
    approval_id: fromBinaryColumn(row.approval_id),
    baseline_id: fromBinaryColumn(row.baseline_id),
    detail,
    candidate_digests: candidateDigests
  };
}
```

and change `startRestore`:

```js
export async function startRestore({
  approvalId, issueId, projectId, baselineId, baselineVersion, actorAccountId, now,
  candidateDigests = {}
}) {
  const restoreId = newId();
  await throwing(
    `INSERT INTO va_restore
     (restore_id, approval_id, issue_id, project_id, baseline_id, baseline_version,
      actor_account_id, started_at, finished_at, attempted, succeeded, failed, skipped,
      irreversible, state, detail, candidate_digests)
     VALUES (FROM_BASE64(?), FROM_BASE64(?), ?, ?, FROM_BASE64(?), ?, ?, ?, NULL, 0, 0, 0, 0, 0, 'RUNNING', NULL, ?)`,
    [
      toBinaryParam(restoreId), toBinaryParam(approvalId), issueId, projectId,
      toBinaryParam(baselineId), baselineVersion, actorAccountId, now,
      JSON.stringify(candidateDigests ?? {})
    ]
  );
  return restoreId;
}
```

- [ ] **Step 6: Pass the candidate digests in**

In `src/usecases/restoreActions.js`, the snapshot already computed for this issue carries the live digests. Change the `startRestore` call:

```js
  const restoreId = await startRestore({ approvalId: approval.approval_id, issueId, projectId,
    baselineId: baseline.baseline_id, baselineVersion: baseline.version,
    actorAccountId: actor.accountId, now: Date.now(),
    // The rejected candidate, frozen before anything is written back. Without
    // this the restore erases the only record of what was rejected.
    candidateDigests: prepared.digests ?? {} });
```

`prepared.digests` does not exist yet. `snapshot()` in `src/usecases/panelAccess.js:57` already calls `project(issue.fields, fields)`, whose result carries both `contentHash` and `digests`, but line 63 only forwards `contentHash`. Add the sibling:

```js
    eligible, fields, editmeta, baselineValues, driftRows, diff,
    contentHash: projection.contentHash,
    // The per-field digests behind contentHash. Task 5 freezes these as the
    // rejected candidate; Task 4's verifier compares the same shape.
    digests: projection.digests,
```

Verify the projection actually exposes them before relying on it:

Run: `grep -n "return {" -A 6 src/lib/content.js | grep -n "digests"`
Expected: `project()` returns an object containing `digests`.

- [ ] **Step 7: Stop the hash substitution in the retry path**

Replace `src/usecases/restore.js`'s `retry` with:

```js
export async function retry(args) { return respond(async () => {
  const prepared = await load(args, { requireAuthority: true });
  const restore = await restoreById(args.payload?.restoreId);
  if (!restore || Number(restore.issue_id) !== prepared.issueId) fail('RESTORE_NOT_FOUND');
  if (restore.state === 'RUNNING') fail('ALREADY_RESTORING');
  if (restore.state === 'COMPLETE') return { success: true, restore };
  if (Number(restore.baseline_version) !== prepared.baselineVersion) fail('STALE_BASELINE');
  const approval = await approvalById(restore.approval_id);
  if (!approval || approval.decision !== 'REJECT' ||
      String(approval.actor_account_id ?? approval.account_id) !== prepared.actor.accountId) fail('NOT_ELIGIBLE');

  // A retry RESUMES the reviewer's signature; it never re-signs. The signed
  // content_hash is passed through untouched, and the item is only allowed to
  // sit somewhere on the path between the rejected candidate and the approved
  // baseline. Substituting today's hash here — as this used to — made the
  // downstream comparison compare a value with itself and pass unconditionally.
  const baselineDigests = typeof prepared.baseline?.field_digests === 'string'
    ? JSON.parse(prepared.baseline.field_digests)
    : (prepared.baseline?.field_digests ?? {});
  const check = resumable({
    baselineDigests,
    candidateDigests: restore.candidate_digests ?? {},
    currentDigests: prepared.digests ?? {}
  });
  if (!check.ok) fail(check.reason);

  // `resuming` is the only place this flag is ever set, and only after
  // resumable() above has proved the item is still on the signed path.
  return applyApproval({ issue: prepared.issue, actor: prepared.actor, approval, prepared, resuming: true });
}); }
```

Add the import: `import { resumable } from '../lib/restore/resume.js';`

- [ ] **Step 8: Let `applyApproval` accept a resumed signature**

`applyApproval` compares `approval.content_hash !== fresh.contentHash` and would now reject every legitimate retry. Add an explicit, named opt-in rather than loosening the check for everyone. In `src/usecases/drift.js`, change the signature to `applyApproval({ issue, actor, approval, prepared, resuming = false })` and the comparison to:

```js
  // `resuming` is set ONLY by usecases/restore.js after resumable() has proved
  // every tracked field still holds either the signed candidate value or the
  // approved baseline value. It relaxes the content-hash equality — never the
  // eligibility, assurance or baseline-version checks around it.
  if (!resuming && approval.content_hash !== fresh.contentHash) fail('STALE_EVIDENCE');
  if (Number(approval.baseline_version ?? fresh.baselineVersion) !== fresh.baselineVersion) fail('STALE_EVIDENCE');
```

and the post-CAS re-read:

```js
    if (!resuming && checked.contentHash !== approval.content_hash) fail('STALE_EVIDENCE');
```

Pass `resuming: true` from `restore.js`'s `retry`. Add `NEW_EVIDENCE_REQUIRES_APPROVAL` and `NO_SIGNED_CANDIDATE` to `DENY` in `src/lib/errors.js` with reviewer-facing copy:

```js
  NEW_EVIDENCE_REQUIRES_APPROVAL: 'This work item changed after you signed. Review the new changes and decide again — the earlier signature does not cover them.',
  NO_SIGNED_CANDIDATE: 'This restore predates candidate capture, so there is no record of what was signed. Review and decide again.',
```

- [ ] **Step 9: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "fix: retries resume the signed operation; signed content hash is never substituted"
```

---

### Task 6: Server-enforced minimum assurance for both decisions

`src/usecases/approval.js:42` uses `ct.required_assurance` directly, and `va_controlled_transition.required_assurance` may be configured to `NATIVE_TRANSITION`, whose provider (`src/lib/approval/providers/native.js:3`) accepts `confirmed: true` with no signature. This is the shared approve/reject path, so a rejection — which triggers a restore that rewrites the issue — can also run unsigned.

**Files:**
- Modify: `src/lib/approval/levels.js`
- Modify: `src/usecases/approval.js:42, 49, 85`
- Modify: `src/usecases/drift.js:42`
- Modify: `src/db/configStore.js:285` (`upsertGatedTransition`)
- Test: `test/approval-assurance.test.js` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `MINIMUM_ASSURANCE: 'ESIGNATURE'`
  - `effectiveAssurance(required): string` — the stronger of `required` and the floor; throws nothing, returns the floor for unknown input.

- [ ] **Step 1: Write the failing tests**

Append to `test/approval-assurance.test.js`:

```js
import { effectiveAssurance, MINIMUM_ASSURANCE } from '../src/lib/approval/levels.js';

test('the floor is an electronic signature', () => {
  assert.equal(MINIMUM_ASSURANCE, 'ESIGNATURE');
});

test('a policy configured below the floor is raised to it', () => {
  assert.equal(effectiveAssurance('NATIVE_TRANSITION'), 'ESIGNATURE');
  assert.equal(effectiveAssurance('JSM_APPROVAL'), 'ESIGNATURE');
});

test('a policy at or above the floor is left alone', () => {
  assert.equal(effectiveAssurance('ESIGNATURE'), 'ESIGNATURE');
  assert.equal(effectiveAssurance('BIOMETRIC'), 'BIOMETRIC');
});

test('an unknown or missing policy falls back to the floor, never below it', () => {
  assert.equal(effectiveAssurance('NONSENSE'), 'ESIGNATURE');
  assert.equal(effectiveAssurance(null), 'ESIGNATURE');
  assert.equal(effectiveAssurance(undefined), 'ESIGNATURE');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/approval-assurance.test.js`
Expected: FAIL — `effectiveAssurance is not a function`.

- [ ] **Step 3: Add the floor**

Append to `src/lib/approval/levels.js`:

```js
/**
 * The assurance no policy may go below.
 *
 * SERVER-ENFORCED, NOT CONFIGURED. `va_controlled_transition.required_assurance`
 * may raise this; nothing may lower it. NATIVE_TRANSITION's provider accepts a
 * session confirmation with no signature, and this app's whole claim is that a
 * controlled record does not change without one — including on rejection, which
 * rewrites the issue through the restore path.
 *
 * Raising the floor is a code change on purpose: it is the kind of decision
 * that should appear in a change-control record, not in a settings screen.
 */
export const MINIMUM_ASSURANCE = ASSURANCE_LEVEL.ESIGNATURE;

/** The stronger of the configured policy and the floor. Unknown input fails to the floor. */
export function effectiveAssurance(required) {
  if (!isAssuranceLevel(required)) return MINIMUM_ASSURANCE;
  return meetsAssurance(required, MINIMUM_ASSURANCE) ? required : MINIMUM_ASSURANCE;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/approval-assurance.test.js`
Expected: PASS.

- [ ] **Step 5: Enforce it on every decision path**

In `src/usecases/approval.js`, import `effectiveAssurance` alongside `meetsAssurance`, then:

- Line 42 becomes:

```js
      // The floor applies to APPROVE and REJECT alike. A supplied code requests
      // stronger authentication and never silently downgrades to native.
      const required = effectiveAssurance(ct.required_assurance);
      const level = payload.code != null ? 'ESIGNATURE' : required;
```

- Line 46's audit payload: `requiredAssurance: required`.
- Line 49 becomes: `if (!meetsAssurance(proof.level, required)) fail('INSUFFICIENT_ASSURANCE');`
- Line 85 in `retryTransition` becomes:
  `if (!meetsAssurance(row.assurance_level, effectiveAssurance(ct.required_assurance))) fail('INSUFFICIENT_ASSURANCE');`

In `src/usecases/drift.js`, line 42 becomes:

```js
  if (!meetsAssurance(approval.assurance_level, effectiveAssurance(fresh.gate?.required_assurance))) fail('INSUFFICIENT_ASSURANCE');
```

with `effectiveAssurance` added to the import from `../lib/approval/levels.js`.

- [ ] **Step 6: Refuse configuration that tries to go below the floor**

In `src/db/configStore.js`'s `upsertGatedTransition`, before the write:

```js
  // Refused at the door rather than silently raised, so an administrator who
  // believes they configured a weaker gate is told they did not.
  if (row.required_assurance != null && !meetsAssurance(row.required_assurance, MINIMUM_ASSURANCE)) {
    throw new FailClosed('ASSURANCE_BELOW_MINIMUM');
  }
```

Add imports `import { meetsAssurance, MINIMUM_ASSURANCE } from '../lib/approval/levels.js';` and `import { FailClosed } from '../lib/errors.js';` if not already present, and add to `DENY` in `src/lib/errors.js`:

```js
  ASSURANCE_BELOW_MINIMUM: 'This app requires an electronic signature for every controlled decision. A transition cannot be configured to accept less.',
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. Tests that configured `required_assurance: 'NATIVE_TRANSITION'` and expected a native approval to succeed must be updated to expect `INSUFFICIENT_ASSURANCE` — that is the intended behaviour change. Find them with `grep -rn "NATIVE_TRANSITION" test/`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: server-enforced ESIGNATURE floor for approvals and rejections"
```

---

### Task 7: Transition before promotion

`src/usecases/approval.js:59` runs `if (true) { applied = await deps.apply(...) }` — capture and baseline publication — and only then, at line 67, asks Jira to transition. Jira can refuse (a transition screen with a required field, a permission, another validator), leaving a published baseline for a status the item never reached.

The approval row must still be activated before the transition, because the workflow validator consumes it. Only the *promotion* moves after.

**Files:**
- Modify: `src/usecases/approval.js:58-69`
- Test: `test/approval-submit.test.js` (add cases)

**Interfaces:**
- Consumes: existing `deps.apply`, `deps.activate`, `deps.performTransition`.
- Produces: `submit(...)` result is unchanged in shape. On a refused transition it returns `{ success: true, transitioned: false, ... }` with **no** `capture`, and the approval row stays `PENDING` for `retryTransition`.

- [ ] **Step 1: Write the failing test**

Append to `test/approval-submit.test.js` (follow the existing dependency-stub style in that file):

```js
test('a refused Jira transition does not publish a baseline', async () => {
  const calls = [];
  const deps = stubDeps({
    apply: async () => { calls.push('apply'); return { success: true }; },
    performTransition: async () => { calls.push('transition'); return { transitioned: false, reason: 'JIRA_REFUSED' }; }
  });
  const result = await createApprovalUsecases(deps).submit({
    payload: { decision: 'APPROVE', transitionId: '31', confirmed: true, code: '123456' },
    context: { accountId: 'signer' }
  });
  assert.equal(result.transitioned, false);
  assert.equal(calls.includes('apply'), false, 'promotion must not run when Jira refused the transition');
  assert.deepEqual(calls, ['transition']);
});

test('a successful transition promotes, in that order', async () => {
  const calls = [];
  const deps = stubDeps({
    apply: async () => { calls.push('apply'); return { success: true }; },
    performTransition: async () => { calls.push('transition'); return { transitioned: true }; }
  });
  const result = await createApprovalUsecases(deps).submit({
    payload: { decision: 'APPROVE', transitionId: '31', confirmed: true, code: '123456' },
    context: { accountId: 'signer' }
  });
  assert.equal(result.transitioned, true);
  assert.deepEqual(calls, ['transition', 'apply'], 'Jira must accept the move before a baseline is published');
});

test('a rejection still applies immediately: there is no transition to wait for', async () => {
  const calls = [];
  const deps = stubDeps({
    apply: async () => { calls.push('apply'); return { success: true, restore: { state: 'COMPLETE' } }; },
    performTransition: async () => { calls.push('transition'); return { transitioned: true }; }
  });
  const result = await createApprovalUsecases(deps).submit({
    payload: { decision: 'REJECT', confirmed: true, code: '123456' },
    context: { accountId: 'signer' }
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['apply']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/approval-submit.test.js`
Expected: FAIL — the first test's `calls` is `['apply', 'transition']`, so `calls.includes('apply')` is `true`.

- [ ] **Step 3: Reorder**

In `src/usecases/approval.js`, replace lines 58–69 with:

```js
      // ── Activate, transition, THEN promote ──────────────────────────────
      //
      // The approval must be active before the move: the workflow validator
      // consumes it while Jira holds the transition open. But promotion —
      // capturing the baseline that says "this is the approved state of this
      // record at this status" — must wait for Jira to actually accept the
      // move. Jira refuses transitions for reasons this app cannot see: a
      // screen with a required field, a permission, another validator. This
      // used to run promotion first (behind an `if (true)`), which published a
      // baseline for a status the item never reached.
      const state = hasTransition ? 'PENDING' : 'CONSUMED';
      if (!await deps.activate({ approvalId: row.approval_id, now: deps.now(), state })) fail('SERVICE_UNAVAILABLE');

      const result = { success: true, approvalId: row.approval_id.toString('hex'), assuranceLevel: row.assurance_level,
        printedName: row.printed_name, meaning: row.meaning, transitioned: false, state };

      const willTransition = hasTransition && payload.preauthorize !== true;
      if (willTransition) Object.assign(result, await deps.performTransition(issue, transition, row));

      // A refused transition leaves the approval PENDING so retryTransition can
      // resume it once the workflow problem is fixed. Nothing is promoted, and
      // the caller is told plainly that the move did not happen.
      if (willTransition && result.transitioned !== true) return result;

      const applied = await deps.apply({ issue, actor, approval: row, prepared, context });
      if (applied?.success !== true) fail('SERVICE_UNAVAILABLE');
      if (applied?.restore) result.restore = applied.restore;
      if (applied?.capture) result.capture = applied.capture;
      return result;
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/approval-submit.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. `test/gate-approval.test.js` and `test/resolver-wiring.test.js` exercise the same path — if either asserts a call order, update it to the new one.

- [ ] **Step 6: Commit**

```bash
git add src/usecases/approval.js test/approval-submit.test.js
git commit -m "fix: promote only after Jira accepts the transition"
```

---

### Task 8: Record an unauthorized transition as an issue-level incident

`src/triggers/issue-transitioned.js:96` logs `not baselined` and falls through to ordinary drift collection. `captureBaseline` returns `reason: 'NO_APPROVAL'` when the edge **is** a configured gate and no consumed approval exists, and `'INSUFFICIENT_ASSURANCE'` when one exists but is too weak. Both mean a controlled transition happened without authorization — most often because the validator is missing from the published workflow. `jobs/gatecheck.js` finds the *configuration* problem; nothing records the *event* against the affected issue.

Ambiguous evidence must stay unresolved: the incident records what was observed and does not infer authorization from a nearby signature.

**Files:**
- Create: `src/db/incidentStore.js`
- Create: `src/lib/incidents.js`
- Modify: `src/db/migrations.js` (append `v022_incident`)
- Modify: `src/lib/ledger.js` (add `EVENT.UNAUTHORIZED_TRANSITION`)
- Modify: `src/triggers/issue-transitioned.js:90-114`
- Modify: `src/usecases/panel.js` (surface open incidents)
- Test: `test/incidents.test.js`

**Interfaces:**
- Consumes: `tryAppend` from `src/db/store.js`, `EVENT` from `src/lib/ledger.js`.
- Produces:
  - `classifyTransition({ captureReason, transition, hasChangelog }): { unauthorized: boolean, kind: string|null, confidence: 'OBSERVED'|'AMBIGUOUS'|null }` (pure)
  - `recordIncident({ issueId, projectId, kind, confidence, actorAccountId, occurredAt, detectedAt, evidence }): Promise<Buffer>` — returns the new `incident_id`
  - `openIncidentsForIssue(issueId): Promise<Row[]>`
  - `openIncidentsForProject(projectId, limit = 100): Promise<Row[]>`

- [ ] **Step 1: Write the failing test**

Create `test/incidents.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransition, INCIDENT } from '../src/lib/incidents.js';

const edge = { from: { id: '10' }, to: { id: '20' }, transitionId: '31', source: 'transition' };

test('a gated edge with no approval is an unauthorized transition', () => {
  const r = classifyTransition({ captureReason: 'NO_APPROVAL', transition: edge, hasChangelog: true });
  assert.equal(r.unauthorized, true);
  assert.equal(r.kind, INCIDENT.UNAUTHORIZED_TRANSITION);
  assert.equal(r.confidence, 'OBSERVED');
});

test('a gated edge with a too-weak approval is also unauthorized', () => {
  const r = classifyTransition({ captureReason: 'INSUFFICIENT_ASSURANCE', transition: edge, hasChangelog: true });
  assert.equal(r.unauthorized, true);
});

test('an uncontrolled edge is not an incident', () => {
  for (const reason of ['NOT_A_GATE', 'DISABLED', 'CAPTURE_DISABLED']) {
    assert.equal(classifyTransition({ captureReason: reason, transition: edge, hasChangelog: true }).unauthorized, false, reason);
  }
});

test('an unresolved edge is recorded as AMBIGUOUS, never dismissed', () => {
  const r = classifyTransition({
    captureReason: 'NO_APPROVAL',
    transition: { from: null, to: { id: '20' }, transitionId: null, source: 'issue-status' },
    hasChangelog: false
  });
  assert.equal(r.unauthorized, true);
  assert.equal(r.confidence, 'AMBIGUOUS');
});

test('a capture error is ambiguous rather than a clean bill of health', () => {
  const r = classifyTransition({ captureReason: 'ERROR', transition: edge, hasChangelog: true });
  assert.equal(r.unauthorized, true);
  assert.equal(r.confidence, 'AMBIGUOUS');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/incidents.test.js`
Expected: FAIL — `Cannot find module '../src/lib/incidents.js'`.

- [ ] **Step 3: Write the pure classifier**

Create `src/lib/incidents.js`:

```js
/**
 * What a transition the app could not authorise actually means.
 *
 * WHY THIS IS A DURABLE INCIDENT AND NOT A LOG LINE. jobs/gatecheck.js finds
 * the CONFIGURATION problem — a validator missing from a published workflow —
 * which is necessary and not sufficient. An auditor asking "did anything move
 * through this gate unauthorised, and which items" needs a dated record against
 * the affected issue. Without the validator Jira never calls the gate, so there
 * is no denial to record; this is the only moment the app can notice, and the
 * only place it can say so.
 *
 * AMBIGUOUS EVIDENCE STAYS AMBIGUOUS. When the edge could not be resolved from
 * the event, or capture failed for an unknown reason, the incident is recorded
 * with confidence AMBIGUOUS and remains open. It is never closed by inferring
 * authorisation from a signature that happens to sit nearby in time.
 *
 * Pure. No I/O, no clock, no database.
 */

export const INCIDENT = {
  UNAUTHORIZED_TRANSITION: 'UNAUTHORIZED_TRANSITION'
};

/** Capture reasons that mean the edge IS controlled and was not authorised. */
const UNAUTHORIZED = new Set(['NO_APPROVAL', 'INSUFFICIENT_ASSURANCE']);

/** Capture reasons that mean this edge was never controlled. Not incidents. */
const BENIGN = new Set(['NOT_A_GATE', 'DISABLED', 'CAPTURE_DISABLED', 'NO_TRACKED_FIELDS']);

export function classifyTransition({ captureReason, transition, hasChangelog }) {
  if (BENIGN.has(captureReason)) {
    return { unauthorized: false, kind: null, confidence: null };
  }

  const resolved = transition?.from?.id != null
    && transition?.to?.id != null
    && transition?.source === 'transition';

  if (UNAUTHORIZED.has(captureReason)) {
    return {
      unauthorized: true,
      kind: INCIDENT.UNAUTHORIZED_TRANSITION,
      // Without a fully resolved edge the app is confident something moved and
      // unsure exactly which edge it took. That distinction belongs in the
      // record, not in a judgement call about whether to write one.
      confidence: resolved && hasChangelog ? 'OBSERVED' : 'AMBIGUOUS'
    };
  }

  // ISSUE_UNREADABLE, CAPTURE_INCOMPLETE, ERROR and anything unrecognised.
  // The app could not establish that this transition was authorised, which is
  // not the same as establishing that it was.
  return { unauthorized: true, kind: INCIDENT.UNAUTHORIZED_TRANSITION, confidence: 'AMBIGUOUS' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/incidents.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the table, the store and the ledger event**

Append to `src/db/migrations.js`:

```js
  // 2026-09-07: a controlled transition the app could not tie to an
  // authorisation. Kept against the ISSUE, not just the workflow, because
  // "which records moved unauthorised" is the question an auditor asks and
  // va_gate_finding cannot answer.
  { id: 'v022_incident', sql: `CREATE TABLE IF NOT EXISTS va_incident (
    incident_id      BINARY(16)   NOT NULL,
    issue_id         BIGINT       NOT NULL,
    project_id       BIGINT       NULL,
    kind             VARCHAR(32)  NOT NULL,
    confidence       VARCHAR(16)  NOT NULL,
    state            VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
    actor_account_id VARCHAR(128) NULL,
    occurred_at      BIGINT       NOT NULL,
    detected_at      BIGINT       NOT NULL,
    resolved_at      BIGINT       NULL,
    resolved_by      VARCHAR(128) NULL,
    evidence         MEDIUMTEXT   NULL,
    PRIMARY KEY (incident_id),
    KEY idx_incident_issue (issue_id, state, occurred_at),
    KEY idx_incident_project (project_id, state, detected_at)
  )` },
```

Add to `EVENT` in `src/lib/ledger.js`:

```js
  // 2026-09-07: a controlled transition arrived that the app could not tie to
  // an authorisation — normally because the va-gate validator is missing from
  // the published workflow, so Jira never called it and there was no transition
  // to deny. GATE_DRIFT_DETECTED records that the control is detached;
  // this records that a specific record moved while it was.
  UNAUTHORIZED_TRANSITION: 'UNAUTHORIZED_TRANSITION',
```

Create `src/db/incidentStore.js`:

```js
import { toBinaryParam, fromBinaryColumn, limitClause } from '../lib/db.js';
import { newId, throwing } from './store.js';

/**
 * va_incident — controlled transitions the app could not tie to an
 * authorisation, recorded against the affected work item.
 *
 * OPEN UNTIL AN ADMINISTRATOR CLOSES IT. Nothing in this module resolves an
 * incident automatically, and in particular nothing correlates it with a
 * signature that happens to sit nearby in time. Inferring consent from
 * proximity is exactly the reasoning an audit is meant to catch.
 */

const INCIDENT_COLUMNS = `
  TO_BASE64(incident_id) AS incident_id, issue_id, project_id, kind, confidence,
  state, actor_account_id, occurred_at, detected_at, resolved_at, resolved_by, evidence
`;

function decode(row) {
  if (!row) return null;
  let evidence = {};
  try {
    evidence = row.evidence ? JSON.parse(row.evidence) : {};
  } catch {
    console.error('incident: unparseable evidence for', row.incident_id);
  }
  return { ...row, incident_id: fromBinaryColumn(row.incident_id), evidence };
}

export async function recordIncident({
  issueId, projectId = null, kind, confidence, actorAccountId = null,
  occurredAt, detectedAt, evidence = {}
}) {
  const incidentId = newId();
  await throwing(
    `INSERT INTO va_incident
     (incident_id, issue_id, project_id, kind, confidence, state, actor_account_id,
      occurred_at, detected_at, resolved_at, resolved_by, evidence)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL, NULL, ?)`,
    [
      toBinaryParam(incidentId), issueId, projectId, kind, confidence,
      actorAccountId, occurredAt, detectedAt, JSON.stringify(evidence ?? {})
    ]
  );
  return incidentId;
}

export async function openIncidentsForIssue(issueId, limit = 50) {
  const rows = await throwing(
    `SELECT ${INCIDENT_COLUMNS} FROM va_incident
     WHERE issue_id = ? AND state = 'OPEN'
     ORDER BY occurred_at DESC LIMIT ${limitClause(limit)}`,
    [issueId]
  );
  return rows.map(decode);
}

export async function openIncidentsForProject(projectId, limit = 100) {
  const rows = await throwing(
    `SELECT ${INCIDENT_COLUMNS} FROM va_incident
     WHERE project_id = ? AND state = 'OPEN'
     ORDER BY detected_at DESC LIMIT ${limitClause(limit)}`,
    [projectId]
  );
  return rows.map(decode);
}

export async function resolveIncident({ incidentId, resolvedBy, now, state = 'RESOLVED' }) {
  await throwing(
    `UPDATE va_incident SET state = ?, resolved_at = ?, resolved_by = ?
     WHERE incident_id = FROM_BASE64(?) AND state = 'OPEN'`,
    [state, now, resolvedBy, toBinaryParam(incidentId)]
  );
}
```

Confirm `throwing` returns rows directly rather than a `{ data }` wrapper before relying on `.map(decode)`:

Run: `grep -n "export async function throwing" -A 8 src/db/store.js`

- [ ] **Step 6: Wire the trigger**

In `src/triggers/issue-transitioned.js`, replace the block from `console.log('transitioned: not baselined', ...)` to the end of the `try`:

```js
    console.log('transitioned: not baselined', JSON.stringify({
      issueKey,
      reason: result.reason,
      ...(result.lookup ? { lookup: result.lookup } : {})
    }));

    // ── Unauthorized transition ──────────────────────────────────────────
    //
    // The edge was controlled and the app could not tie the move to an
    // authorisation. Recorded against the issue, with the transition evidence
    // that was available, and never resolved by inferring consent from a
    // signature that happens to be nearby.
    const verdict = classifyTransition({
      captureReason: result.reason,
      transition,
      hasChangelog: (changelog?.items ?? []).length > 0
    });
    if (verdict.unauthorized) {
      const evidence = {
        fromStatusId: transition.from?.id ?? null,
        toStatusId: transition.to?.id ?? null,
        transitionId: transition.transitionId ?? null,
        resolvedFrom: transition.source,
        changelogId: changelog?.id ?? null,
        captureReason: result.reason
      };
      const incidentId = await recordIncident({
        issueId, projectId: result.projectId ?? null, kind: verdict.kind,
        confidence: verdict.confidence, actorAccountId, occurredAt: transitionAt,
        detectedAt: now, evidence
      });
      console.error('transitioned: UNAUTHORIZED', JSON.stringify({ issueKey, ...evidence, confidence: verdict.confidence }));
      await tryAppend({
        actorAccountId: actorAccountId ?? 'system',
        eventType: EVENT.UNAUTHORIZED_TRANSITION,
        issueId,
        payload: { incidentId: incidentId.toString('base64'), confidence: verdict.confidence, ...evidence }
      });
    }

    const review = await getReview(issueId);
    if (review && review.baseline_id != null) {
      await collect({ issueId, issueKey, detectedVia: DETECTED_VIA.EVENT, actorAccountId, now });
    }
```

Add the imports:

```js
import { classifyTransition } from '../lib/incidents.js';
import { recordIncident } from '../db/incidentStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from '../lib/ledger.js';
```

- [ ] **Step 7: Surface it in the panel**

In `src/usecases/panel.js`'s `getState`, add `incidents: await openIncidentsForIssue(prepared.issueId)` to the response object, importing `openIncidentsForIssue` from `../db/incidentStore.js`. Confirm the panel response contract is extensible:

Run: `grep -n "eligibility, approval, record, drift" src/usecases/panel.js frontend/src -r`

The merge contract in `docs/IMPLEMENTATION.md` states the panel response "may add issue, transitions, credentialEnrolled, error" — adding `incidents` is consistent with that. Update that line in `docs/IMPLEMENTATION.md` to list `incidents` too.

- [ ] **Step 8: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. If a control-wiring test asserts every `va_*` table is referenced by code, `va_incident` now is — via `incidentStore.js`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: record UNAUTHORIZED_TRANSITION incidents against the affected issue"
```

---

### Task 9: Prove the restore write identity at setup

`src/lib/restore/executor.js:99` picks `api.asApp()` by default (`DEFAULT_PROJECT_CONFIG.restore.actAs === 'app'`) while every PUT requests `overrideScreenSecurity=true&overrideEditableFlag=true`. Those overrides are honoured for a caller with **Administer Jira**; `asApp()` is not a general bypass. The first time anyone learns this is mid-rejection, when the write fails.

The probe must be non-destructive: a PUT of a field to the value it already holds, or — better — `GET /rest/api/3/mypermissions` for the acting identity plus an `editmeta` read. Both are needed: permission tells you whether the override will be honoured, `editmeta` tells you whether the tracked fields are on a screen at all.

**Files:**
- Create: `src/lib/restore/writeIdentity.js`
- Modify: `src/usecases/adminDiagnostics.js`
- Modify: `src/resolvers/admin.js` (register the endpoint)
- Test: `test/restore-write-identity.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `classifyWriteIdentity({ actAs, permissions, editmeta, controlledFields }): { ok: boolean, severity: 'OK'|'WARN'|'BLOCK', findings: { code, fieldId?, message }[] }` (pure)
  - `checkRestoreWriteIdentity(req, overrides)` admin endpoint returning that verdict for a sample issue.

- [ ] **Step 1: Write the failing test**

Create `test/restore-write-identity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWriteIdentity } from '../src/lib/restore/writeIdentity.js';

const fields = [{ field_id: 'summary', field_name: 'Summary' }, { field_id: 'duedate', field_name: 'Due date' }];
const editmeta = { summary: { operations: ['set'] }, duedate: { operations: ['set'] } };
const admin = { ADMINISTER: true, EDIT_ISSUES: true };

test('an administer-capable identity with every field editable is OK', () => {
  const r = classifyWriteIdentity({ actAs: 'user', permissions: admin, editmeta, controlledFields: fields });
  assert.equal(r.ok, true);
  assert.equal(r.severity, 'OK');
  assert.deepEqual(r.findings, []);
});

test('asApp with overrides requested and no Administer Jira is a BLOCK', () => {
  const r = classifyWriteIdentity({
    actAs: 'app', permissions: { ADMINISTER: false, EDIT_ISSUES: true }, editmeta, controlledFields: fields
  });
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'BLOCK');
  assert.equal(r.findings[0].code, 'OVERRIDE_NOT_AVAILABLE');
});

test('no edit permission at all is a BLOCK', () => {
  const r = classifyWriteIdentity({
    actAs: 'user', permissions: { ADMINISTER: true, EDIT_ISSUES: false }, editmeta, controlledFields: fields
  });
  assert.equal(r.severity, 'BLOCK');
  assert.equal(r.findings.some(f => f.code === 'CANNOT_EDIT'), true);
});

test('a tracked field missing from editmeta is a WARN naming the field', () => {
  const r = classifyWriteIdentity({
    actAs: 'user', permissions: admin,
    editmeta: { summary: { operations: ['set'] } }, controlledFields: fields
  });
  assert.equal(r.severity, 'WARN');
  const finding = r.findings.find(f => f.code === 'FIELD_NOT_WRITABLE');
  assert.equal(finding.fieldId, 'duedate');
  assert.match(finding.message, /Due date/);
});

test('a tracked field present but without a set operation is a WARN', () => {
  const r = classifyWriteIdentity({
    actAs: 'user', permissions: admin,
    editmeta: { summary: { operations: ['set'] }, duedate: { operations: [] } },
    controlledFields: fields
  });
  assert.equal(r.findings.some(f => f.code === 'FIELD_NOT_WRITABLE' && f.fieldId === 'duedate'), true);
});

test('unknown permissions fail closed rather than passing', () => {
  const r = classifyWriteIdentity({ actAs: 'user', permissions: null, editmeta, controlledFields: fields });
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'BLOCK');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/restore-write-identity.test.js`
Expected: FAIL — `Cannot find module '../src/lib/restore/writeIdentity.js'`.

- [ ] **Step 3: Write the classifier**

Create `src/lib/restore/writeIdentity.js`:

```js
/**
 * Can the configured restore identity actually perform a restore?
 *
 * WHY THIS IS A SETUP CHECK. lib/restore/executor.js sends
 * `overrideScreenSecurity=true&overrideEditableFlag=true` on every write. Those
 * overrides are honoured for a caller with Administer Jira; asApp() is not a
 * general bypass, and the app's default is asApp(). Left unchecked, the first
 * person to discover the mismatch is a reviewer halfway through a rejection —
 * the worst possible moment and the least actionable audience.
 *
 * FIELDS AND PERMISSIONS ARE DIFFERENT FAILURES. Permission decides whether the
 * override applies at all; editmeta decides whether a tracked field is on this
 * project's screens. An administrator can fix either, but only if told which.
 *
 * Pure. No I/O, no clock, no database.
 */

const BLOCK = 'BLOCK';
const WARN = 'WARN';
const OK = 'OK';

export function classifyWriteIdentity({ actAs, permissions, editmeta = {}, controlledFields = [] }) {
  const findings = [];

  if (permissions == null || typeof permissions !== 'object') {
    // Unknown is not "fine". A setup check that passes when it could not read
    // the answer is worse than no check.
    return {
      ok: false, severity: BLOCK,
      findings: [{ code: 'PERMISSIONS_UNKNOWN', message: 'Jira did not report this identity\'s permissions, so the restore path could not be validated.' }]
    };
  }

  if (permissions.EDIT_ISSUES !== true) {
    findings.push({ code: 'CANNOT_EDIT', message: 'The configured restore identity cannot edit work items in this project, so no field can be written back.' });
  }

  if (permissions.ADMINISTER !== true) {
    // The overrides are unconditional in the executor, so this is a BLOCK
    // rather than a note: a restore of a field on a locked screen will fail.
    findings.push({
      code: 'OVERRIDE_NOT_AVAILABLE',
      message: actAs === 'app'
        ? 'Restores are attributed to the app, which does not hold Administer Jira here. Jira honours the screen and editability overrides the restore relies on only for a caller with Administer Jira. Configure restore.actAs to a user who has it, or grant the app that permission.'
        : 'The configured restore identity does not hold Administer Jira, so Jira will not honour the screen and editability overrides the restore relies on.'
    });
  }

  for (const field of controlledFields) {
    const meta = editmeta?.[field.field_id];
    const settable = Array.isArray(meta?.operations) && meta.operations.includes('set');
    if (!settable) {
      findings.push({
        code: 'FIELD_NOT_WRITABLE',
        fieldId: field.field_id,
        message: `${field.field_name ?? field.field_id} is tracked but is not editable on this project's screens, so it cannot be written back by a restore.`
      });
    }
  }

  const severity = findings.some((f) => f.code === 'CANNOT_EDIT' || f.code === 'OVERRIDE_NOT_AVAILABLE')
    ? BLOCK
    : findings.length > 0 ? WARN : OK;

  return { ok: severity === OK, severity, findings };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/restore-write-identity.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the admin endpoint**

Append to `src/usecases/adminDiagnostics.js`:

```js
import { classifyWriteIdentity } from '../lib/restore/writeIdentity.js';
import { projectConfig, controlledFields } from '../db/configStore.js';

/**
 * "Would a restore actually work here?", answered at setup rather than mid-
 * rejection. Non-destructive: two reads, no write.
 */
export async function checkRestoreWriteIdentity(req, overrides) {
  return runAdmin(req, async deps => {
    const { projectId, issueKey, issueTypeId } = req.payload ?? {};
    if (!/^[1-9]\d*$/.test(String(projectId))) throw new Error('Invalid project.');
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(String(issueKey ?? ''))) throw new Error('A sample work item key is required.');

    const config = await projectConfig(projectId);
    const actAs = config?.restore?.actAs ?? 'app';
    // The SAME identity the executor will use. Probing as the admin who opened
    // this screen would answer a question nobody asked.
    const client = actAs === 'user' ? deps.asUser() : deps.asApp();
    const { route } = deps;

    const [permissions, editmeta, fields] = await Promise.all([
      readPermissions(client, route, projectId),
      readEditmeta(client, route, issueKey),
      controlledFields({ projectId, issueTypeId })
    ]);

    return { actAs, issueKey, ...classifyWriteIdentity({ actAs, permissions, editmeta, controlledFields: fields }) };
  }, overrides);
}

/** null on any failure: classifyWriteIdentity treats unknown permissions as BLOCK. */
async function readPermissions(client, route, projectId) {
  try {
    const res = await client.requestJira(
      route`/rest/api/3/mypermissions?projectId=${String(projectId)}&permissions=ADMINISTER,EDIT_ISSUES`);
    if (!res.ok) return null;
    const body = await res.json();
    return {
      ADMINISTER: body.permissions?.ADMINISTER?.havePermission === true,
      EDIT_ISSUES: body.permissions?.EDIT_ISSUES?.havePermission === true
    };
  } catch (e) {
    console.error('writeIdentity: permission read failed', e);
    return null;
  }
}

/** {} on failure: every tracked field then reports FIELD_NOT_WRITABLE, which is the safe read. */
async function readEditmeta(client, route, issueKey) {
  try {
    const res = await client.requestJira(route`/rest/api/3/issue/${issueKey}/editmeta`);
    if (!res.ok) return {};
    return (await res.json()).fields ?? {};
  } catch (e) {
    console.error('writeIdentity: editmeta read failed', issueKey, e);
    return {};
  }
}
```

`deps.asApp`, `deps.asUser` and `deps.route` are set unconditionally by `adminDependencies` (`src/usecases/adminRuntime.js:9`), so no profile is needed and `adminRuntime.js` does not change.

Register `admin:checkRestoreWriteIdentity` in `src/resolvers/admin.js` next to the other diagnostics endpoints. Confirm the naming convention first:

Run: `grep -n "adminDiagnostics\|define(" src/resolvers/admin.js | head -20`

- [ ] **Step 6: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`. `test/resolver-wiring.test.js` asserts manifest↔code wiring — if it enumerates admin endpoints, add the new one there.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: validate the restore write identity at setup instead of mid-rejection"
```

---

## After this plan

Run the full verification gate before declaring the plan done:

```bash
npm run verify   # test + smoke + frontend build
```

Then write Plan 2 (`STRICT`/`DETECT` policy, proposal snapshots, durable operation states, one server-owned signature resolver). Plan 2 depends on this one: the operation-state machine it introduces is only worth building on a restore path whose `COMPLETE` means what it says.

**Deliberately deferred to Plan 2, not forgotten:**

| Audit item | Why it waits |
|---|---|
| Jira-level locking (`jira.issue.editable=false`, permission schemes) | Needs the `STRICT`/`DETECT` policy model and setup-time precondition validation. |
| Unsigned automatic recall to "Under Review" (`src/lib/restore/recall.js`) | Under `STRICT` the app must set incident state without moving the issue. Removing recall before the replacement exists would leave drifted items unrestricted. |
| Durable operation states; one signature resolver with server-created challenges | Whole-subsystem change spanning resolvers, storage and the frontend. |
| Versioned baseline snapshots with per-field schema and adapter version | Schema change to `va_baseline`/`va_baseline_value`; Task 2 exports `ADAPTER_VERSION` and Task 5 adds `candidate_digests` as the first step toward it. |
| Transition-ID-keyed policy and published-workflow reconciliation | Extends `va_controlled_transition`; builds on Task 8's incident record. |

**Deferred to Plan 3:** Part 11 control ownership and validation records, batching and resumable background execution, Forge event retry requests in place of swallowed errors, progressive ADF rendering, AI evidence provenance.
