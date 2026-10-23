/**
 * THE TEST-MANAGEMENT WORK TYPES, AS DATA.
 *
 * Six global work types, named as on harshapalepu01 (project ATX, 2026-10-22).
 * There they share the project's default screen and workflow because the tool
 * there keeps everything in its own backend. Here each type gets its own screens,
 * screen scheme and workflow, so a Test Case, an Execution and a Defect each
 * show the fields and statuses that belong to them.
 *
 * What VAtlassian signs stays out of Jira fields: objective, preconditions,
 * steps, datasets, environment, configurations, results and sign-offs live in
 * the Test management panel (Forge SQL) and its signatures. So no status here
 * says "Approved" or "Passed", and no custom field repeats a signed value; an
 * auditor reads those from the panel, never from something anyone can edit.
 *
 * Statuses, fields and screens that ALREADY EXIST with a planned name are
 * reused by reference (statuses, and fields marked reuseIfGlobal) or stop the
 * run (everything else this setup did not create). Icons are Jira system
 * icons, chosen so none repeats an icon VAT's existing work types use.
 *
 * Screen field tokens: a Jira field id ('summary', 'parent', 'customfield_…'),
 * or 'f:<key>' for a field in the type's own `fields` list.
 */

const TEAM = 'customfield_10001';
const START_DATE = 'customfield_10015';

export const PLAN = {
  source: 'harshapalepu01.atlassian.net, project ATX (names); VAtlassian test-management design (screens and workflows)',

  // Custom fields. Each created field gets a context scoped to the project and
  // the work types that use it. reuseIfGlobal: an existing global field of the
  // same name and kind is referenced, never modified.
  fields: [
    { key: 'level', name: 'Test Level', kind: 'select', options: ['Component', 'Integration', 'System', 'Acceptance', 'Validation'],
      description: 'The V-model level this test verifies at. Validation tests check intended use.' },
    { key: 'automation', name: 'Automation Status', kind: 'select', options: ['Manual', 'Automated', 'To be automated'],
      description: 'Whether this test is run by hand or by a CI job.' },
    { key: 'severity', name: 'Severity', kind: 'select', reuseIfGlobal: true,
      description: 'How badly the defect affects the product.' },
    { key: 'rootCause', name: 'Root cause', kind: 'textarea', reuseIfGlobal: true,
      description: 'Why the defect happened.' }
  ],

  issueTypes: [
    {
      key: 'case', name: 'TestCase', avatarId: 10313, vatlassianRole: 'Test',
      description: 'Test case: objective, preconditions and steps, versioned and signed.',
      fields: ['level', 'automation'],
      screens: {
        create: ['summary', 'issuetype', 'parent', 'f:level', 'f:automation', 'description', 'priority', 'components', 'labels', 'assignee', 'attachment'],
        edit: ['summary', 'issuetype', 'parent', 'f:level', 'f:automation', 'description', 'priority', 'components', 'labels', 'assignee', 'reporter', TEAM, 'attachment', 'issuelinks'],
        view: ['summary', 'issuetype', 'parent', 'f:level', 'f:automation', 'description', 'priority', 'components', 'labels', 'assignee', 'reporter', TEAM, 'attachment', 'issuelinks']
      },
      // Jira-side authoring state only. Which version may run, and who signed
      // it, is the Test management panel's signed version, not this status.
      workflow: {
        name: 'VAtlassian Test Case Workflow',
        description: 'VAtlassian test case authoring. Versions are signed in the Test management panel; Obsolete is frozen. va-gate on every transition.',
        statuses: [
          { key: 'draft', name: 'Draft', statusCategory: 'TODO' },
          { key: 'review', name: 'In Review', statusCategory: 'IN_PROGRESS' },
          { key: 'ready', name: 'Ready', statusCategory: 'DONE' },
          { key: 'obsolete', name: 'Obsolete', statusCategory: 'DONE', editable: false }
        ],
        transitions: [
          { name: 'Submit for review', from: ['draft'], to: 'review' },
          { name: 'Mark ready', from: ['review'], to: 'ready' },
          { name: 'Request rework', from: ['review'], to: 'draft' },
          { name: 'Revise', from: ['ready'], to: 'draft' },
          { name: 'Retire', from: ['draft', 'review', 'ready'], to: 'obsolete' }
        ]
      }
    },
    {
      key: 'execution', name: 'TestExecution', avatarId: 10310, vatlassianRole: 'Test Execution',
      description: 'Test execution: the runs of signed test versions, with results, evidence and sign-off.',
      fields: [],
      // VAtlassian creates retest executions as the app: Parent and Labels
      // must be on the create screen (checked on enable and before a rerun).
      screens: {
        create: ['summary', 'issuetype', 'parent', 'description', 'fixVersions', 'assignee', START_DATE, 'duedate', 'priority', 'components', 'labels'],
        edit: ['summary', 'issuetype', 'parent', 'description', 'fixVersions', 'assignee', START_DATE, 'duedate', 'priority', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks'],
        view: ['summary', 'issuetype', 'parent', 'description', 'fixVersions', 'assignee', START_DATE, 'duedate', 'priority', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks']
      },
      // Done and Cancelled are Done-category: va-gate's execution guard holds
      // both while any run is not terminal or is waiting for its bug. No
      // reopen: a retest is a new execution.
      workflow: {
        name: 'VAtlassian Test Execution Workflow',
        description: 'VAtlassian test execution. Done and Cancelled are held by va-gate until every run is terminal and every failed run has its bug. A retest is a new execution.',
        statuses: [
          { key: 'todo', name: 'To Do', statusCategory: 'TODO' },
          { key: 'progress', name: 'In Progress', statusCategory: 'IN_PROGRESS' },
          { key: 'done', name: 'Done', statusCategory: 'DONE' },
          { key: 'cancelled', name: 'Cancelled', statusCategory: 'DONE' }
        ],
        transitions: [
          { name: 'Start', from: ['todo'], to: 'progress' },
          { name: 'Complete', from: ['progress'], to: 'done' },
          { name: 'Cancel', from: ['todo', 'progress'], to: 'cancelled' }
        ]
      }
    },
    {
      key: 'plan', name: 'TestPlan', avatarId: 10306, vatlassianRole: 'Test Plan',
      description: 'Test plan: the signed scope of tests, release, configurations and environment for a campaign.',
      fields: [],
      screens: {
        create: ['summary', 'issuetype', 'parent', 'description', 'fixVersions', 'assignee', START_DATE, 'duedate', 'components', 'labels'],
        edit: ['summary', 'issuetype', 'parent', 'description', 'fixVersions', 'assignee', START_DATE, 'duedate', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks'],
        view: ['summary', 'issuetype', 'parent', 'description', 'fixVersions', 'assignee', START_DATE, 'duedate', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks']
      },
      workflow: {
        name: 'VAtlassian Test Plan Workflow',
        description: 'VAtlassian test plan. Plan revisions are published and signed in the Test management panel. va-gate on every transition.',
        statuses: [
          { key: 'draft', name: 'Draft', statusCategory: 'TODO' },
          { key: 'active', name: 'Active', statusCategory: 'IN_PROGRESS' },
          { key: 'closed', name: 'Closed', statusCategory: 'DONE' }
        ],
        transitions: [
          { name: 'Activate', from: ['draft'], to: 'active' },
          { name: 'Close', from: ['active'], to: 'closed' },
          { name: 'Reopen', from: ['closed'], to: 'active' }
        ]
      }
    },
    {
      key: 'set', name: 'TestSet', avatarId: 10316, vatlassianRole: 'Test Set',
      description: 'Test set: a signed group of tests.',
      fields: [],
      screens: {
        create: ['summary', 'issuetype', 'parent', 'description', 'assignee', 'components', 'labels'],
        edit: ['summary', 'issuetype', 'parent', 'description', 'assignee', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks'],
        view: ['summary', 'issuetype', 'parent', 'description', 'assignee', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks']
      },
      workflow: {
        name: 'VAtlassian Test Set Workflow',
        description: 'VAtlassian test set. Membership is published and signed in the Test management panel; Obsolete is frozen. va-gate on every transition.',
        statuses: [
          { key: 'draft', name: 'Draft', statusCategory: 'TODO' },
          { key: 'active', name: 'Active', statusCategory: 'IN_PROGRESS' },
          { key: 'obsolete', name: 'Obsolete', statusCategory: 'DONE', editable: false }
        ],
        transitions: [
          { name: 'Activate', from: ['draft'], to: 'active' },
          { name: 'Revise', from: ['active'], to: 'draft' },
          { name: 'Retire', from: ['draft', 'active'], to: 'obsolete' }
        ]
      }
    },
    {
      key: 'precondition', name: 'TestPrecondition', avatarId: 10308, vatlassianRole: 'Precondition',
      description: 'Test precondition: a reusable state that must hold before a test runs.',
      fields: [],
      screens: {
        create: ['summary', 'issuetype', 'parent', 'description', 'assignee', 'components', 'labels'],
        edit: ['summary', 'issuetype', 'parent', 'description', 'assignee', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks'],
        view: ['summary', 'issuetype', 'parent', 'description', 'assignee', 'components', 'labels', 'reporter', TEAM, 'attachment', 'issuelinks']
      },
      workflow: {
        name: 'VAtlassian Test Precondition Workflow',
        description: 'VAtlassian test precondition. Obsolete is frozen. va-gate on every transition.',
        statuses: [
          { key: 'draft', name: 'Draft', statusCategory: 'TODO' },
          { key: 'active', name: 'Active', statusCategory: 'IN_PROGRESS' },
          { key: 'obsolete', name: 'Obsolete', statusCategory: 'DONE', editable: false }
        ],
        transitions: [
          { name: 'Activate', from: ['draft'], to: 'active' },
          { name: 'Revise', from: ['active'], to: 'draft' },
          { name: 'Retire', from: ['draft', 'active'], to: 'obsolete' }
        ]
      }
    },
    {
      key: 'defect', name: 'TestDefect', avatarId: 10304, vatlassianRole: 'Bug',
      description: 'Test defect: a defect raised from a failed test run.',
      fields: ['severity', 'rootCause'],
      // VAtlassian creates the automatic bug as the app with summary,
      // description, parent, labels and (when offered) fix versions; Labels and
      // Parent must be on the create screen, Reporter lets the signer report it.
      // Nothing here is required, so the app's create is never refused.
      screens: {
        create: ['summary', 'issuetype', 'parent', 'f:severity', 'priority', 'description', 'environment', 'versions', 'fixVersions', 'components', 'labels', 'assignee', 'reporter', 'attachment'],
        edit: ['summary', 'issuetype', 'parent', 'f:severity', 'priority', 'description', 'environment', 'versions', 'fixVersions', 'components', 'labels', 'assignee', 'reporter', 'f:rootCause', TEAM, 'attachment', 'issuelinks'],
        view: ['summary', 'issuetype', 'parent', 'f:severity', 'priority', 'description', 'environment', 'versions', 'fixVersions', 'components', 'labels', 'assignee', 'reporter', 'f:rootCause', TEAM, 'attachment', 'issuelinks'],
        resolve: ['f:rootCause', 'fixVersions']
      },
      // A green release result still needs a signed passing retest; Resolved
      // and Closed only say the fix is in.
      workflow: {
        name: 'VAtlassian Test Defect Workflow',
        description: 'VAtlassian test defect. A green release result needs a signed passing retest as well as closure. va-gate on every transition.',
        statuses: [
          { key: 'open', name: 'Open', statusCategory: 'TODO' },
          { key: 'progress', name: 'In Progress', statusCategory: 'IN_PROGRESS' },
          { key: 'resolved', name: 'Resolved', statusCategory: 'DONE' },
          { key: 'closed', name: 'Closed', statusCategory: 'DONE' },
          { key: 'rejected', name: 'Rejected', statusCategory: 'DONE' }
        ],
        transitions: [
          { name: 'Start progress', from: ['open'], to: 'progress' },
          { name: 'Resolve', from: ['open', 'progress'], to: 'resolved', screen: 'resolve' },
          { name: 'Close', from: ['resolved'], to: 'closed' },
          { name: 'Reopen', from: ['resolved', 'closed', 'rejected'], to: 'open' },
          { name: 'Reject', from: ['open', 'progress'], to: 'rejected' }
        ]
      }
    }
  ],

  // Screen and scheme names follow the requirements setup's pattern.
  screenName: (type, key) => `VAtlassian ${type.name.replace(/^Test/, 'Test ')} ${key[0].toUpperCase()}${key.slice(1)}`,
  screenSchemeName: (type) => `VAtlassian ${type.name.replace(/^Test/, 'Test ')} Screen Scheme`,

  // harshapalepu01's test link types, same directions. "Defect" is taken on
  // mgtechdemo, so that one is "Test Defect". VAtlassian keeps plans, sets and
  // preconditions in Forge SQL; it links bugs with the bug link type and
  // sources with the Verifies type chosen on the Test management page. So
  // these are only created with --link-types.
  linkTypes: [
    { name: 'Test Defect', inward: 'defect created by', outward: 'defect created' },
    { name: 'Precondition', inward: 'is precondition for', outward: 'has precondition' },
    { name: 'Test Execution', inward: 'is test execution for', outward: 'has test execution' },
    { name: 'Test Plan Coverage', inward: 'covers in test plan', outward: 'is covered by test plan' },
    { name: 'Tests', inward: 'tests', outward: 'is tested by' },
    { name: 'Test Set Coverage', inward: 'covers in test set', outward: 'is covered by test set' }
  ]
};
