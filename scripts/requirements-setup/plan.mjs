/**
 * Define the names and configuration created by Requirements setup.
 *
 * Setup-owned configuration objects use PLAN.prefix, "REQ: ...", to identify
 * them on admin screens. User-facing work-type, status, field and link-type
 * names have no prefix.
 *
 * Reuse existing same-named statuses, fields and link types by reference without
 * modifying them. Attach new schemes only to a new project; leave shared and
 * default schemes unchanged.
 */

export const PLAN = {
  prefix: 'REQ: ',

  project: {
    key: 'REQ',
    name: 'Requirements Pilot',
    description: 'VAtlassian Requirements pilot. Requirement items are reviewed, signed and baselined; Baselined and Released items change only through an approved Change Request.'
  },

  // "Requirement" is taken on mgtechdemo by a level-2 (above Epic) type used by
  // other projects; the blueprint allows the plural.
  issueType: {
    name: 'Requirements',
    description: 'One atomic, reviewable requirement with its own workflow, signature, baseline history, links and change record.'
  },

  // GLOBAL objects (work-types.mjs). Not tied to any project: a project picks
  // them up by adding the work type to its work type scheme and mapping it to
  // the workflow in its workflow scheme.
  requirementsWorkflowName: 'VAtlassian Requirements Workflow',
  requirementsLayout: { draft: [0, 0], review: [300, 0], rework: [300, 150], rejected: [600, 150], baselined: [600, 0], released: [900, 0], revision: [600, -150], obsolete: [900, 150] },
  // One screen holding only the VAtlassian signature field, used by every
  // signed transition in both workflows. VAtlassian reads the signature from
  // the transition screen, so a signed transition without it cannot be signed.
  signatureScreenName: 'VAtlassian Signature',

  sourceDocument: {
    issueType: {
      name: 'Source Document',
      description: 'An original source document (the PDF), its version, source hash and provenance. Requirements trace back to it.'
    },
    workflowName: 'VAtlassian Source Document Workflow',
    // Current and Superseded are frozen: the PDF and its provenance must not
    // change once the document is the one requirements are derived from.
    statuses: [
      { key: 'registered', name: 'Registered', statusCategory: 'TODO', editable: true },
      { key: 'current', name: 'Current', statusCategory: 'DONE', editable: false, lockAttachments: true },
      { key: 'superseded', name: 'Superseded', statusCategory: 'DONE', editable: false, lockAttachments: true }
    ],
    transitions: [
      { name: 'Make current', from: ['registered'], to: 'current', controlled: { role: 'APPROVER', captureBaseline: true }, requireFields: ['identifier', 'version', 'issuer', 'received', 'hash'] },
      { name: 'Supersede', from: ['current'], to: 'superseded', controlled: { role: 'APPROVER', captureBaseline: false } }
    ],
    layout: { registered: [0, 0], current: [300, 0], superseded: [600, 0] },
    // The provenance of the PDF. Filled in while Registered; frozen from Current.
    fields: [
      { key: 'identifier', name: 'Document Identifier', kind: 'text',
        description: 'The issuer\'s own number for this document, e.g. SRS-0042.' },
      { key: 'version', name: 'Document Version', kind: 'text',
        description: 'The issuer\'s version or revision of this document, e.g. 2.1 or Rev C.' },
      { key: 'issuer', name: 'Document Issuer', kind: 'text',
        description: 'Who issued the document: customer, regulator, standards body or internal team.' },
      { key: 'received', name: 'Received Date', kind: 'date',
        description: 'When this version of the document was received.' },
      // Typed by the registrar today. VAtlassian's baseline hashes the attached
      // bytes itself; this field is the issuer's or registrar's declared hash.
      { key: 'hash', name: 'Source Hash', kind: 'text',
        description: 'SHA-256 of the attached PDF as received.' }
    ],
    screens: {
      create: ['summary', 'f:identifier', 'f:version', 'f:issuer', 'f:received', 'f:hash', 'description', 'attachment', 'assignee', 'labels'],
      edit: ['summary', 'f:identifier', 'f:version', 'f:issuer', 'f:received', 'f:hash', 'description', 'attachment', 'assignee', 'labels', 'issuelinks'],
      view: ['summary', 'f:identifier', 'f:version', 'f:issuer', 'f:received', 'f:hash', 'description', 'attachment', 'assignee', 'reporter', 'labels', 'issuelinks']
    }
  },

  // Screen names for the global work types (screens.mjs). Screens are global
  // in Jira; the fields on them reach only the projects in their contexts.
  screenNames: {
    requirements: { create: 'VAtlassian Requirements Create', edit: 'VAtlassian Requirements Edit', view: 'VAtlassian Requirements View', rework: 'VAtlassian Requirements Rework', retire: 'VAtlassian Requirements Retire', revision: 'VAtlassian Requirements Revision', scheme: 'VAtlassian Requirements Screen Scheme' },
    sourceDocument: { create: 'VAtlassian Source Document Create', edit: 'VAtlassian Source Document Edit', view: 'VAtlassian Source Document View', scheme: 'VAtlassian Source Document Screen Scheme' }
  },

  // statusCategory uses the workflow API values TODO, IN_PROGRESS and DONE.
  // editable: false sets jira.issue.editable=false for this status in this workflow.
  // That Jira setting and VAtlassian's drift hold enforce the Baselined/Released
  // editing policy together.
  statuses: [
    { key: 'draft', name: 'Draft', statusCategory: 'TODO', editable: true },
    { key: 'review', name: 'In Review', statusCategory: 'IN_PROGRESS', editable: false },
    { key: 'rework', name: 'Needs Rework', statusCategory: 'IN_PROGRESS', editable: true },
    { key: 'baselined', name: 'Baselined', statusCategory: 'DONE', editable: false, lockAttachments: true },
    { key: 'revision', name: 'Revision in Progress', statusCategory: 'IN_PROGRESS', editable: true },
    { key: 'released', name: 'Released', statusCategory: 'DONE', editable: false, lockAttachments: true },
    { key: 'rejected', name: 'Rejected', statusCategory: 'DONE', editable: false, lockAttachments: true },
    { key: 'obsolete', name: 'Obsolete', statusCategory: 'DONE', editable: false, lockAttachments: true }
  ],

  // `requireBeforeReview` fields are enforced by a required-field validator on
  // every transition INTO In Review. `requiredAlways` fields are required by
  // the field configuration (create and edit).
  fields: [
    { key: 'level', name: 'Requirement Level', kind: 'select', options: ['Stakeholder', 'System', 'Software', 'Component', 'Interface'], requiredAlways: true,
      description: 'The decomposition level this requirement sits at.' },
    { key: 'type', name: 'Requirement Type', kind: 'select', options: ['Functional', 'Non-functional', 'Constraint', 'Regulatory', 'Safety', 'Interface', 'Derived'], requiredAlways: true,
      description: 'What kind of requirement this is.' },
    { key: 'rationale', name: 'Rationale', kind: 'textarea', requireBeforeReview: true,
      description: 'Why this requirement exists.' },
    { key: 'source', name: 'Source / Origin', kind: 'text', requireBeforeReview: true,
      description: 'URL or reference to where this requirement came from. Mandatory for stakeholder and regulatory requirements.' },
    // Reused: the site already has a global "Acceptance Criteria" paragraph field.
    { key: 'acceptance', name: 'Acceptance Criteria', kind: 'textarea', requireBeforeReview: true, reuseIfGlobal: true,
      description: 'How a reviewer can tell the requirement is met.' },
    { key: 'verification', name: 'Verification Method', kind: 'multicheckbox', options: ['Test', 'Analysis', 'Inspection', 'Demonstration'], requireBeforeReview: true,
      description: 'How the requirement will be verified.' },
    { key: 'classification', name: 'Safety / Regulatory Classification', kind: 'select',
      // The blueprint requires project-specific values. The project administrator
      // replaces these placeholders in the field context.
      options: ['Not classified', 'Safety-related', 'Regulatory', 'Safety-related and regulatory'],
      description: 'Project-controlled safety / regulatory classification. Set before review when applicable.' },
    { key: 'obsolescence', name: 'Obsolescence Rationale', kind: 'textarea',
      description: 'Why the requirement was retired, and what replaces it. Only set when retiring.' }
  ],

  // The existing Change Management type (lives in VAT). Read by the VAtlassian
  // CCB check (not built yet), recorded here so the decision is in one place.
  changeControl: {
    issueTypeName: 'Change Request',
    approvedStatuses: ['Closed'],
    rejectedStatuses: ['Rejected']
  },

  // VAtlassian's signature field, put on the signing transition screens.
  signatureFieldName: 'Electronic Signature',

  // Native fields by Jira id. 'issuelinks' on a screen is the "Linked issues" editor.
  screens: {
    create: ['summary', 'f:level', 'f:type', 'description', 'f:rationale', 'f:acceptance', 'f:verification', 'f:source', 'assignee', 'components', 'fixVersions', 'labels'],
    edit: ['summary', 'f:level', 'f:type', 'description', 'f:rationale', 'f:acceptance', 'f:verification', 'f:source', 'f:classification', 'assignee', 'components', 'fixVersions', 'labels', 'attachment', 'issuelinks'],
    view: ['summary', 'f:level', 'f:type', 'description', 'f:rationale', 'f:acceptance', 'f:verification', 'f:source', 'f:classification', 'assignee', 'reporter', 'components', 'fixVersions', 'labels', 'attachment', 'issuelinks', 'f:obsolescence'],
    // Transition screens. 'sig' is the VAtlassian Electronic Signature field.
    sign: ['sig'],
    rework: ['assignee'],
    retire: ['f:obsolescence', 'issuelinks'],
    revision: ['issuelinks', 'sig']
  },

  transitions: [
    { name: 'Submit for review', from: ['draft'], to: 'review', requireBeforeReview: true },
    { name: 'Approve and sign', from: ['review'], to: 'baselined', screen: 'sign', controlled: { role: 'APPROVER', captureBaseline: true } },
    { name: 'Request rework', from: ['review'], to: 'rework', screen: 'rework' },
    { name: 'Reject', from: ['review'], to: 'rejected', screen: 'rework' },
    { name: 'Resubmit for review', from: ['rework'], to: 'review', requireBeforeReview: true },
    { name: 'Release', from: ['baselined'], to: 'released' },
    // The linked Change Request approval check is not implemented; see docs/plans.
    // This transition currently requires a VAtlassian signature and the screen asks
    // for the Change Request link.
    { name: 'Authorize revision', from: ['baselined', 'released'], to: 'revision', screen: 'revision', controlled: { role: 'APPROVER', captureBaseline: false } },
    { name: 'Submit revision for review', from: ['revision'], to: 'review', requireBeforeReview: true },
    { name: 'Retire', from: ['baselined', 'released'], to: 'obsolete', screen: 'retire', requireFields: ['obsolescence'] }
  ],

  // Site-wide link types, matched by NAME only. Same wording on another type
  // (e.g. Jira Product Discovery's "implements") is deliberately not reused.
  linkTypes: [
    { name: 'Derives', outward: 'derives from', inward: 'is derived by' },
    { name: 'Satisfies', outward: 'satisfies', inward: 'is satisfied by' },
    { name: 'Verifies', outward: 'verifies', inward: 'is verified by' },
    { name: 'Implements', outward: 'implements', inward: 'is implemented by' },
    { name: 'Mitigates', outward: 'mitigates', inward: 'is mitigated by' },
    { name: 'Conflicts', outward: 'conflicts with', inward: 'conflicts with' },
    { name: 'Replaces', outward: 'replaces', inward: 'is replaced by' },
    { name: 'Affects', outward: 'affects', inward: 'is affected by' }
  ]
};
