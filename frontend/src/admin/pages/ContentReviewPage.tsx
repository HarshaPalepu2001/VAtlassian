import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Card, EmptyState, Field, IssueLink, Page, Select, Table } from '../../ui/primitives';
import { Notice, When } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';

type Change = {
  issueKey: string;
  issueId?: string;
  summary?: string;
  fieldName?: string;
  actorName?: string;
  changedAt?: number;
  driftId?: string;
  materiality?: string;
};

export default function ContentReviewPage({ projects = [] }: { projects?: Project[] }) {
  const [projectId, setProjectId] = useState('');
  const [items, setItems] = useState<Change[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setLoading(true);
    setError('');
    setItems([]);
    setHasMore(false);
    try {
      const r = assertResult(
        await invoke<Result & { changes: Change[]; hasMore?: boolean }>('admin:listContentChanges', {
          projectId: projectId ? projectId : undefined
        })
      );
      if (seq !== sequence.current) return;
      setItems(r.changes ?? []);
      setHasMore(r.hasMore === true);
    } catch (e) {
      if (seq === sequence.current) setError(errorMessage(e));
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => {
      ++sequence.current;
    };
  }, [load]);

  return (
    <Page
      eyebrow="Evidence"
      title="Content changes"
      lead="Unresolved changes to approved content. Open the work item to review the evidence and record a decision."
      actions={
        <Button isDisabled={loading} onClick={load}>
          Refresh
        </Button>
      }
    >
      <div className="va-stack">
        {projects.length > 0 && (
          <Field label="Project filter">
            <Select
              value={projectId}
              disabled={loading}
              onChange={setProjectId}
              placeholder="All projects"
              options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </Field>
        )}
        {error && (
          <Notice danger>
            {error} <Button isDisabled={loading} onClick={load}>Retry</Button>
          </Notice>
        )}
        {hasMore && (
          <Notice>
            Showing the latest 200 changes. More changes remain; use My approvals to review pending work.
          </Notice>
        )}
        <Card flush>
          {error ? (
            <EmptyState title="Changes could not be loaded" />
          ) : !items.length ? (
            <EmptyState title={loading ? 'Loading changes…' : 'No unresolved changes'} />
          ) : (
            <Table
              columns={[
                { key: 'issue', label: 'Work item' },
                { key: 'field', label: 'Field' },
                { key: 'who', label: 'Changed by' },
                { key: 'when', label: 'When' }
              ]}
            >
              {items.map((c, i) => (
                <tr key={c.driftId ?? `${c.issueId}:${i}`}>
                  <td>
                    <IssueLink
                      issueKey={c.issueKey ?? c.issueId}
                      summary={c.summary ?? (!c.issueKey ? 'Work item details unavailable' : undefined)}
                    />
                  </td>
                  <td>
                    {c.fieldName ?? 'Controlled content'} {c.materiality}
                  </td>
                  <td>{c.actorName ?? 'Not recorded'}</td>
                  <td>
                    <When ms={c.changedAt} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </Page>
  );
}

