import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import { Card, Facts, Loading, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';

type SpaceRole = Result & {
  vault: boolean;
  spaceKey?: string;
  projectCount?: number;
  lockedProjectCount?: number;
};

/** Reports what this app does with the current space. There is deliberately nothing
 *  to configure here: approver roles, required assurance, retention and attachment
 *  handling are all scoped to a Jira project, not to a Confluence space, and are set
 *  in the Jira admin console. A vault space is provisioned and locked down by the app
 *  itself, so it is described here rather than administered. */
export default function ConfluenceSpaceSetup() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [role, setRole] = useState<SpaceRole | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setRole(assertResult(await invoke<SpaceRole>('confluence:getSpaceRole')));
    } catch (e) {
      setRole(null);
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading label="Loading space status…" />;

  return (
    <Page
      eyebrow="VAtlassian"
      title="Space status"
      lead="What this app does with this space. Governance policy is configured per Jira project, not per space."
      actions={<Button onClick={() => void load()}>Reload</Button>}
    >
      {error && <Notice danger>{error}</Notice>}
      {!error && role?.vault && (
        <Card title="Evidence vault" subtitle="Provisioned and maintained by the app">
          <p>
            This is the site's single evidence vault: one page per Jira project, one child page per
            work item, holding the attachments captured with each approved baseline. The app created
            it private to itself. Do not add pages here or widen its permissions by hand.
          </p>
          <Facts
            items={[
              { label: 'Space key', value: role.spaceKey ?? 'Not recorded' },
              { label: 'Jira projects vaulted', value: String(role.projectCount ?? 0) },
              {
                label: 'Attachment deletion locked',
                value: `${role.lockedProjectCount ?? 0} of ${role.projectCount ?? 0} projects`
              }
            ]}
          />
        </Card>
      )}
      {!error && role && !role.vault && (
        <Card title="Not governed by this app">
          <p>
            This app holds no configuration for this space. Pages are protected individually from
            the byline and the page actions menu, and everything else — approver roles, required
            assurance, retention and attachment handling — is set per Jira project in the
            VAtlassian admin console in Jira.
          </p>
        </Card>
      )}
    </Page>
  );
}
