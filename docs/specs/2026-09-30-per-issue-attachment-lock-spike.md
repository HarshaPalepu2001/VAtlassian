# Spike: lock attachment deletion per baselined item, not per project

**Date:** 2026-09-30
**Status:** Defined; not run. Running it edits a Jira workflow, so it needs an explicit go-ahead.
**Context:** `docs/specs/2026-09-24-attachment-restore-design.md` §9.1

## 1. Why

The only lock the app has today is the project-level one
(`lockAttachmentDeletion`): it removes Delete own/all attachments from the
project's **permission scheme**. That is too wide:

- it locks every item in the project, baselined or not;
- a permission scheme is usually shared, so it locks other projects too;
- it cannot be undone by the app (the scheme's earlier contents were never
  recorded before 2026-09-30).

It is now off by default. What is wanted instead is a lock on the items that
are baselined: once an item is approved, its files cannot be deleted by a
person, while everything else in the project behaves normally.

## 2. The candidate: workflow status properties

Jira honours permission properties on a workflow **status**. While an item
sits in that status:

| Property | Effect |
|---|---|
| `jira.permission.attachdeleteall.denied` | nobody may delete any attachment |
| `jira.permission.attachdeleteown.denied` | nobody may delete their own attachment |
| `jira.permission.attachdeleteall.projectrole` = `<role id>` | only that role may delete any attachment |
| `jira.permission.createattachment.denied` | nobody may add an attachment |

A baselined item normally sits in the controlled transition's target status
(Approved, Baselined, Released…). Setting the properties on exactly those
statuses locks the baselined items, and only while they sit there.

Is it truly "per item"? Almost. The lock follows the **status**, so:

- an item in that status which was never baselined is locked too;
- an item moved out of the status gets delete rights back, but moving it out
  is itself a transition, which `va-gate` holds while the item has drift.

## 3. Questions the spike answers

Run on mgtechdemo against a **scratch project with its own workflow and its
own permission scheme**, never VAT's.

1. **Can the app write it?** Read the workflow as `lib/workflowSource.js`
   does (`GET /rest/api/3/workflows`), then
   `POST /rest/api/3/workflows/update` with properties added to one status,
   everything else unchanged (version, transitions, the admin's own
   properties, the `va-gate` validators). Scope: `manage:jira-configuration`,
   which the app already holds. Is a draft/publish step needed for an active
   workflow?
2. **Are people blocked?** With `attachdeleteall.denied` +
   `attachdeleteown.denied` on the status, can a Jira admin and a project admin
   delete a file on an item in that status (UI and REST)? They must not.
3. **Is the app blocked too?** A rejection deletes files added after approval,
   as the app. If `.denied` blocks the app, test the restricting form
   `jira.permission.attachdeleteall.projectrole` = the id of
   `atlassian-addons-project-access` together with `attachdeleteown.denied`,
   and record whether Jira needs numbered duplicate keys
   (`...projectrole.1`) for more than one holder.
4. **Adding files.** `createattachment.denied` blocks adding files on a
   baselined item. What does it also block, such as attachments pasted into a
   comment? Is that wanted, given that adding a file already holds the item
   through drift?
5. **Mechanics.** Does the update fit a 25 s resolver, or does it need the
   queue? What happens on a concurrent edit (version conflict), and how is it
   retried? What does undoing the property look like?

The probe is a `PROBE_SECRET`-guarded webtrigger modelled on
`src/jobs/probe.js`, with an explicit `mode=write` and the scratch project
key as required inputs. It is deleted when the spike ends.

## 4. Decision

Adopt it only if **all** of these hold:

- the app can set **and remove** the properties reliably, without disturbing
  anything else in the workflow;
- people, Jira admins included, cannot delete a file on an item in the status;
- the app can still delete, in one form or the other;
- the workflow is not shared with projects the admin has not chosen, or the
  admin accepts that scope explicitly.

If they hold, the next spec replaces the project toggle with a per-rule
setting ("lock files on items in <target status>"). The app records what it set
so it can undo it, `gatecheck` reports a property that was removed by hand,
and the Settings card shows which statuses are locked.

If they do not hold, keep the opt-in project lockdown plus detect-and-restore,
which is what ships today.

## 5. Trade-offs to record either way

- The lock follows the status, not the item.
- Workflows are shared across projects and issue types like schemes are, so
  the same warning is needed.
- The app edits a customer's workflow. That is more intrusive than editing a
  permission scheme, and it has to be reversible and visible.
