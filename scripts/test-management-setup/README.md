# Test-management setup

Brings the six test work types into a company-managed project, each with its
own fields, screens and workflow, ready to map on VAtlassian's Test management
page. Read-only dry run unless given `--apply`. Uses the requirements setup's
credentials (`.env.requirements`), Jira client and created-object ledger — see
[../requirements-setup/README.md](../requirements-setup/README.md).

```
node scripts/test-management-setup/setup.mjs --project <KEY> [--link-types] [--apply]
```

The type names come from harshapalepu01 (project ATX: TestCase, TestExecution,
TestPlan, TestSet, TestPrecondition, TestDefect). ATX gives them the project's
default screen and workflow because the tool there keeps everything in its own backend;
this setup does not copy that. Per type it creates:

| Type | Own fields | Workflow |
|---|---|---|
| TestCase | Test Level, Automation Status | Draft → In Review → Ready; Obsolete (frozen) |
| TestExecution | — | To Do → In Progress → Done; Cancelled |
| TestPlan | — | Draft → Active → Closed (Reopen) |
| TestSet | — | Draft → Active → Obsolete (frozen) |
| TestPrecondition | — | Draft → Active → Obsolete (frozen) |
| TestDefect | Severity, Root cause (existing global fields) | Open → In Progress → Resolved → Closed; Rejected; Reopen |

Each type gets its own create, edit and view screens and screen scheme, plus a
Resolve screen for TestDefect. VAtlassian signs some content, and none of it
lives in a Jira field or status: objective, steps, datasets, environment,
configurations, results and sign-offs. No status says "Approved" or "Passed".
va-gate is on every transition, so the execution guard holds both routes into
Done. Nothing is required beyond Jira's own Summary and Reporter, so the app
can always create automatic bugs and retest executions. Parent and Labels are
on every create screen.

`plan.mjs` holds the names, fields, screens and workflows as data.

## Applied on mgtechdemo

- 2026-10-22: `--project VAT --apply` (first version, mirroring ATX). Types
  10719–10724, added to `VAT: Kanban Issue Type Scheme` (14721); default screen
  and workflow.
- 2026-10-22: `--project VAT --link-types --apply`. Link types 10102–10107:
  Test Defect, Precondition, Test Execution, Test Plan Coverage, Tests, Test
  Set Coverage, with harshapalepu01's directions.
- 2026-10-22: `--project VAT --apply` (this version). Fields
  customfield_13598 (Test Level) and customfield_13599 (Automation Status),
  screens 12806–12824, screen schemes 12084–12089 mapped in 11733, new statuses
  Ready (10851) and Active (10852), six workflows mapped in workflow scheme 11735.
  VAT-82 and VAT-83 kept In Review.
