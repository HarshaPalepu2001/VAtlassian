/**
 * HOW MUCH WE KNOW ABOUT ONE OBSERVED CHANGE (docs/specs/2026-10-03-baseline-evidence-model-design.md §7.1).
 *
 * A Jira event only wakes the collector. Its user is who TRIGGERED the check,
 * and `now` is when the difference was SEEN. Neither is the editor or the edit
 * time: those come only from a matching Jira history item. Each fact has its
 * own column, so a fallback can never pass for a confirmed edit.
 */
export const EDIT_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  UNATTRIBUTED: 'UNATTRIBUTED',
  HISTORY_UNAVAILABLE: 'HISTORY_UNAVAILABLE'
});

export function editStatusFor({ changelogId, historyComplete }) {
  if (changelogId) return EDIT_STATUS.CONFIRMED;
  return historyComplete ? EDIT_STATUS.UNATTRIBUTED : EDIT_STATUS.HISTORY_UNAVAILABLE;
}

/** The provenance columns of one va_drift row. */
export function observationColumns({ changelogId, attributionAt, historyComplete, detectedVia, actorAccountId, now }) {
  const status = editStatusFor({ changelogId, historyComplete });
  return {
    observed_at: now,
    trigger_kind: detectedVia ?? null,
    trigger_account_id: actorAccountId ?? null,
    edit_status: status,
    edited_at: status === EDIT_STATUS.CONFIRMED ? attributionAt ?? null : null,
    changelog_id: changelogId ?? null
  };
}

const time = value => (value == null ? null : Number(value));

/**
 * One observation, decoded. A row written before the provenance columns
 * existed is decoded for what it actually recorded: with a changelog id it is a
 * confirmed edit whose observation time was never kept; without one, its actor
 * was the event's user and its time was when the collector looked.
 */
export function observationOf(row) {
  if (row.edit_status) {
    const confirmed = row.edit_status === EDIT_STATUS.CONFIRMED;
    return {
      observedAt: time(row.observed_at),
      trigger: { kind: row.trigger_kind ?? null, accountId: row.trigger_account_id ?? null },
      edit: {
        status: row.edit_status,
        editorAccountId: confirmed ? row.actor_account_id ?? null : null,
        editorName: confirmed ? row.actor_name ?? null : null,
        editedAt: confirmed ? time(row.edited_at) : null,
        changelogId: confirmed ? row.changelog_id ?? null : null
      }
    };
  }
  if (row.changelog_id) {
    return {
      observedAt: null,
      trigger: { kind: row.detected_via ?? null, accountId: null },
      edit: { status: EDIT_STATUS.CONFIRMED, editorAccountId: row.actor_account_id ?? null,
        editorName: row.actor_name ?? null, editedAt: time(row.occurred_at), changelogId: row.changelog_id }
    };
  }
  return {
    observedAt: time(row.occurred_at),
    trigger: { kind: row.detected_via ?? null, accountId: row.actor_account_id ?? null },
    edit: { status: EDIT_STATUS.UNATTRIBUTED, editorAccountId: null, editorName: null, editedAt: null, changelogId: null }
  };
}
