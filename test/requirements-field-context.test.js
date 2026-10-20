import test from 'node:test';
import assert from 'node:assert/strict';
import { planFieldContext } from '../scripts/requirements-setup/field-context.mjs';
import { findCustomFieldsByName, findReusableCustomField } from '../scripts/requirements-setup/field-discovery.mjs';
import { findLinkType } from '../scripts/requirements-setup/link-type.mjs';
import {
  createMetaFieldIds,
  fieldAssociationPayload,
  missingFieldAssociations
} from '../scripts/requirements-setup/field-association.mjs';

test('a scoped field variant never deletes Jira default global context', () => {
  const plan = planFieldContext({
    contexts: [
      { id: '100', name: 'Default Configuration Scheme for Requirement Level', isGlobalContext: true },
      { id: '101', name: 'VAT: Requirements', isGlobalContext: false }
    ],
    scopedName: 'VAT: Requirements'
  });

  assert.equal(plan.scopedContext.id, '101');
  assert.deepEqual(plan.contextIdsToDelete, []);
});

test('a missing scoped variant is created alongside the global context', () => {
  const plan = planFieldContext({
    contexts: [
      { id: '100', name: 'Default Configuration Scheme for Requirement Level', isGlobalContext: true }
    ],
    scopedName: 'VAT: Requirements'
  });

  assert.equal(plan.scopedContext, null);
  assert.equal(plan.createScopedContext, true);
  assert.deepEqual(plan.contextIdsToDelete, []);
});

test('duplicate scoped variants fail closed instead of choosing one', () => {
  assert.throws(() => planFieldContext({
    contexts: [
      { id: '101', name: 'VAT: Requirements', isGlobalContext: false },
      { id: '102', name: 'VAT: Requirements', isGlobalContext: false }
    ],
    scopedName: 'VAT: Requirements'
  }), /Several contexts are named/);
});

test('field discovery uses Jira admin search so a new unscreened field is found', async () => {
  const paths = [];
  const jira = {
    async all(path) {
      paths.push(path);
      assert.match(path, /^\/rest\/api\/3\/field\/search\?query=/);
      return [
        { id: 'customfield_13586', name: 'Requirement Level', schema: { custom: 'select' } },
        { id: 'customfield_99999', name: 'Requirement Level detail', schema: { custom: 'text' } },
        { id: 'summary', name: 'Requirement Level', schema: { system: 'summary' } }
      ];
    }
  };

  const fields = await findCustomFieldsByName(jira, 'Requirement Level');

  assert.deepEqual(fields.map((field) => field.id), ['customfield_13586']);
  assert.equal(paths.length, 1);
});

test('duplicate reusable fields select the unique field already established on screens', async () => {
  const jira = {
    async all(path) {
      if (path.startsWith('/rest/api/3/field/search?query=')) return [
        { id: 'customfield_11768', name: 'Acceptance Criteria', schema: { custom: 'textarea' } },
        { id: 'customfield_12231', name: 'Acceptance Criteria', schema: { custom: 'textarea' } }
      ];
      if (path === '/rest/api/3/field/customfield_11768/screens') return [{ id: '11176' }];
      if (path === '/rest/api/3/field/customfield_12231/screens') return [];
      throw new Error(`Unexpected path ${path}`);
    }
  };

  const field = await findReusableCustomField(jira, 'Acceptance Criteria');

  assert.equal(field.id, 'customfield_11768');
});

test('link type reuse matches only the exact name, case-insensitively', () => {
  const live = [
    { id: '1', name: 'Derives from', outward: 'derives from', inward: 'is derived by' },
    { id: '2', name: 'DERIVES', outward: 'derives from', inward: 'is derived by' }
  ];

  assert.equal(findLinkType(live, 'Derives').id, '2');
  assert.equal(findLinkType(live, 'Satisfies'), null);
});

test('a Jira field catalogue detects newly created fields that still need project association', () => {
  const metadata = {
    fields: [
      { fieldId: 'summary', name: 'Summary' },
      { key: 'customfield_13586', name: 'Requirement Level' }
    ]
  };

  assert.deepEqual([...createMetaFieldIds(metadata)], ['summary', 'customfield_13586']);
  assert.deepEqual(
    missingFieldAssociations(['customfield_13586', 'customfield_13587'], metadata),
    ['customfield_13587']
  );
});

test('field association payload is project-scoped, deduplicated, and uses Jira identifiers', () => {
  assert.deepEqual(fieldAssociationPayload('11851', ['customfield_13586', 'customfield_13586', 'customfield_13587']), {
    associationContexts: [{ identifier: 11851, type: 'PROJECT_ID' }],
    fields: [
      { identifier: 'customfield_13586', type: 'FIELD_ID' },
      { identifier: 'customfield_13587', type: 'FIELD_ID' }
    ]
  });
});
