# Test management UI cleanup

Intent: reduce the amount shown at once, correct spacing, and fit the Jira issue-panel and administration experience. Keep the existing Forge hosting, permissions, resolver calls, audit records, and recovery behavior. Preserve pre-existing local changes.

Design: left-aligned system typography; host Atlassian color and font tokens with existing light/dark fallbacks; 8/12/16/24px spacing; 4px control corners; compact status lozenges; quiet section rules. No decorative metrics, hero, new fonts, gradients, or dashboard cards.

1. Add accessible, keyboard-operated tabs with mounted inactive panels so drafts survive navigation. Group test definition, versions, runs, and coverage; group planning draft/revisions; group execution runs/summary/rerun; group admin mappings/sign-off/repairs.
2. Add a stylesheet scoped to test management. Normalize field groups, action rows, compact tables, overflow, focus, mobile/narrow iframe behavior, and sign-off spacing. Keep unrelated app surfaces unchanged.
3. Put optional datasets, references, audit metadata, evidence history and run setup behind disclosures. Retain full frozen content before signing, visible errors and all recovery controls. Keep publication and save actions beside their draft.
4. Check existing test-management regressions and add interaction coverage for tab navigation and retained drafts. Build/lint the frontend. Review actual rendered fixture screens at narrow/wide widths and in both themes; fixture verification is separate from live Jira acceptance.

Review focus: unsaved draft retention; keyboard focus/hidden panels; frozen signed content; retries and uncertain requests; table overflow and long hashes. No deployment or tenant mutation is part of this change.
