import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Card, Field, Page, Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';

type ConfigData = { config?: { policy?: { mode: 'STRICT' | 'DETECT' } } };

export default function SettingsPage({ projects }: { projects: Project[] }) {
  const [projectId, setProject] = useState('');
  const [mode, setMode] = useState<'STRICT' | 'DETECT'>('DETECT');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = assertResult(await invoke<Result & ConfigData>('admin:getConfig', { projectId }));
      setMode(r.config?.policy?.mode ?? 'DETECT');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [projectId]);

  useEffect(() => {
    setMode('DETECT');
    setError('');
    setMessage('');
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      // Need to load the existing config and modify policy.mode
      const current = assertResult(await invoke<Result & ConfigData>('admin:getConfig', { projectId }));
      const config = current.config ?? {};
      const currentPolicy = config.policy ?? { mode: 'DETECT' };
      config.policy = { ...currentPolicy, mode };

      assertResult(await invoke<Result>('admin:saveConfig', { projectId, config }));
      setMessage('Settings saved successfully.');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page eyebrow="Configuration" title="Settings">
      <div className="va-stack">
        <Field label="Project">
          <Select
            value={projectId}
            onChange={setProject}
            placeholder="Choose a project"
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Field>
        {error && <Notice danger>{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        {projectId && (
          <Card title="Policy Mode">
            <Notice>
              <strong>Review Required</strong>
              <br />
              VAtlassian operates in DETECT mode by default, recording changes after they occur. Enabling STRICT mode will require a valid proposal and signature before any changes can be applied. Ensure your workflows have <code>jira.issue.editable=false</code> enabled and unresolved drift is handled before switching.
            </Notice>
            <div className="va-form-grid" style={{ marginTop: '16px' }}>
              <Field label="Operating Mode">
                <Select
                  value={mode}
                  onChange={(v) => setMode(v as 'STRICT' | 'DETECT')}
                  placeholder="Choose mode"
                  options={[
                    { value: 'DETECT', label: 'Detect (Asynchronous tracking)' },
                    { value: 'STRICT', label: 'Strict (Locked issues, proposed snapshots)' }
                  ]}
                />
              </Field>
            </div>
            <div className="va-form-actions" style={{ marginTop: '16px' }}>
              <Button appearance="primary" isDisabled={busy} onClick={save}>
                Save Settings
              </Button>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
