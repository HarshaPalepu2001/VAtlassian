const fs = require('fs');
const content = fs.readFileSync('src/usecases/drift.js', 'utf8');

const target = `    const capture = await writeCapturedBaseline({ issueId: checked.issueId, issueKey: checked.issue.key,
      projectId: checked.projectId, issueTypeId: checked.issueTypeId, controlledFields: checked.fields,
      issueFields: checked.issue.fields, editmetaFields: checked.editmeta,
      transitionAt: approval.decided_at ?? approval.signed_at ?? Date.now(), capturedAt: Date.now(),
      approver: { accountId: actor.accountId, displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
        approvalId: approval.approval_id, assuranceLevel: approval.assurance_level },
      fromStatusId: approval.from_status_id, toStatusId: approval.to_status_id,
      requiredRole: checked.gate.required_role, reviewerFieldId: checked.config.reviewerFieldId });
    if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');`;

const replacement = `    let capture = { captured: false, reason: 'CAPTURE_DISABLED' };
    // Only capture a new baseline if this is NOT a transition configured to skip baselining.
    // (Null gate means it's a direct drift approval, which always baselines).
    if (!checked.gate || (checked.gate.capture_baseline !== false && checked.gate.capture_baseline !== 0)) {
      capture = await writeCapturedBaseline({ issueId: checked.issueId, issueKey: checked.issue.key,
        projectId: checked.projectId, issueTypeId: checked.issueTypeId, controlledFields: checked.fields,
        issueFields: checked.issue.fields, editmetaFields: checked.editmeta,
        transitionAt: approval.decided_at ?? approval.signed_at ?? Date.now(), capturedAt: Date.now(),
        approver: { accountId: actor.accountId, displayName: approval.actor_name ?? approval.printed_name ?? actor.displayName,
          approvalId: approval.approval_id, assuranceLevel: approval.assurance_level },
        fromStatusId: approval.from_status_id, toStatusId: approval.to_status_id,
        requiredRole: checked.gate?.required_role, reviewerFieldId: checked.config.reviewerFieldId });
      if (!capture.captured) fail(capture.reason ?? 'CAPTURE_FAILED');
    }`;

fs.writeFileSync('src/usecases/drift.js', content.replace(target, replacement));
