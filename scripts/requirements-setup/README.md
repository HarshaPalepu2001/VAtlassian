# Requirements setup

Sets up the VAtlassian **Source Document** and **Requirements** work types in
Jira, following the client setup blueprint. Every script is a read-only dry run
unless given `--apply`.

## Credentials

Create `.env.requirements` at the repo root (gitignored by `.env*`):

```
JIRA_SITE=https://mgtechdemo.atlassian.net
JIRA_EMAIL=<a Jira site administrator's email>
JIRA_API_TOKEN=<API token from https://id.atlassian.com/manage-profile/security/api-tokens>
```

The scripts never print or store the token.

## Steps

1. `node scripts/requirements-setup/inspect.mjs` reads configuration and writes
   `.out/inspect.json`.
2. `node scripts/requirements-setup/work-types.mjs [--apply]` creates the two
   global work types, their statuses, the VAtlassian signature screen and both
   workflows. It does not attach them to a project.
3. `node scripts/requirements-setup/attach-project.mjs --project <KEY> [--apply]`
   adds both work types to an existing company-managed project and maps their
   workflows. It refuses shared schemes, conflicting mappings and existing items.
4. `node scripts/requirements-setup/screens.mjs --project <KEY> [--apply]` creates
   custom fields scoped to each project and work type, create/edit/view screens,
   Requirements transition screens and a screen scheme per work type. It maps
   those schemes in the project's work-type screen scheme and adds transition
   screens and "filled in" validators to both workflows. It refuses shared
   work-type screen schemes and existing mappings.
5. `node scripts/requirements-setup/link-types.mjs [--apply]` creates the planned
   site-wide trace link types. It reuses existing exact-name types without changes.
6. `node scripts/requirements-setup/setup.mjs [--apply]` creates the dedicated
   `REQ` project, including fields, screens and schemes. It has not been run and
   predates steps 2 through 5.

`plan.mjs` holds every name, status, transition and field as data.

Every created id, and every change to an existing scheme (with how to undo it),
is recorded in `.out/state.<site>.json` (`state.mjs`) the moment it happens. A
re-run skips what exists; a name clash with something not in that ledger stops
the run.

## Applied on mgtechdemo

- 2026-10-14: steps 2 and 3 for `VAT`.
