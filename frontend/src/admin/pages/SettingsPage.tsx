import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge, Card, Field, Loading, Page, Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';

type ConfigData = Result & {
  config: {
    enabled?: boolean;
    visibility?: 'reviewer-only' | 'all';
    queueThreshold?: 'COSMETIC' | 'MINOR' | 'MAJOR' | 'CRITICAL';
    reviewStatusIds?: string[];
    ai?: {
      enabled: boolean;
      maxCompletionTokens?: number;
      models?: { light?: string; standard?: string; deep?: string };
    };
    restore?: {
      commentOnRestore?: boolean;
      notifyUsers?: boolean;
      perFieldRetries?: number;
      actAs?: 'app' | 'user';
    };
    notifications?: {
      digest?: boolean;
      digestAfterHours?: number;
    };
    policy?: {
      mode?: string;
    };
  };
  revision: string | null;
};

export default function SettingsPage({ projects }: { projects: Project[] }) {
  const [projectId, setProject] = useState('');
  const [saved, setSaved] = useState<ConfigData | null>(null);

  // Form states
  const [enabled, setEnabled] = useState(true);
  const [visibility, setVisibility] = useState<'reviewer-only' | 'all'>('reviewer-only');
  const [queueThreshold, setQueueThreshold] = useState<'COSMETIC' | 'MINOR' | 'MAJOR' | 'CRITICAL'>('MINOR');
  const [aiEnabled, setAiEnabled] = useState(true);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [commentOnRestore, setCommentOnRestore] = useState(true);
  const [notifyUsersOnRestore, setNotifyUsersOnRestore] = useState(false);

  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  const syncForm = (data: ConfigData) => {
    setEnabled(data.config.enabled !== false);
    setVisibility(data.config.visibility === 'all' ? 'all' : 'reviewer-only');
    setQueueThreshold(data.config.queueThreshold ?? 'MINOR');
    setAiEnabled(data.config.ai?.enabled !== false);
    setMaxTokens(data.config.ai?.maxCompletionTokens ?? 4096);
    setCommentOnRestore(data.config.restore?.commentOnRestore !== false);
    setNotifyUsersOnRestore(data.config.restore?.notifyUsers === true);
  };

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setSaved(null);
    setError('');
    try {
      const r = assertResult(
        await invoke<ConfigData>('admin:getConfig', { projectId: projectId || undefined })
      );
      if (seq !== sequence.current) return;
      setSaved(r);
      syncForm(r);
    } catch (e) {
      if (seq === sequence.current) setError(errorMessage(e));
    }
  }, [projectId]);

  useEffect(() => {
    setMessage('');
    void load();
    return () => {
      ++sequence.current;
    };
  }, [load]);

  const isDirty = Boolean(
    saved &&
      (enabled !== (saved.config.enabled !== false) ||
        visibility !== (saved.config.visibility === 'all' ? 'all' : 'reviewer-only') ||
        queueThreshold !== (saved.config.queueThreshold ?? 'MINOR') ||
        aiEnabled !== (saved.config.ai?.enabled !== false) ||
        maxTokens !== (saved.config.ai?.maxCompletionTokens ?? 4096) ||
        commentOnRestore !== (saved.config.restore?.commentOnRestore !== false) ||
        notifyUsersOnRestore !== (saved.config.restore?.notifyUsers === true) ||
        saved.config.policy?.mode === 'STRICT')
  );

  async function save() {
    if (!saved || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const payloadConfig: Record<string, any> = {
        enabled,
        visibility,
        queueThreshold,
        ai: {
          enabled: aiEnabled,
          maxCompletionTokens: Number(maxTokens) || 4096
        },
        restore: {
          commentOnRestore,
          notifyUsers: notifyUsersOnRestore
        },
        ...(saved.config.policy?.mode === 'STRICT' ? { policy: { mode: 'DETECT' } } : {})
      };

      assertResult(
        await invoke<Result>('admin:saveConfig', {
          projectId: projectId || undefined,
          expectedRevision: saved.revision,
          config: payloadConfig
        })
      );
      await load();
      setMessage(
        projectId
          ? 'Project settings saved. The latest values are active.'
          : 'Site-wide default settings saved. All inheriting projects are updated.'
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const handleReset = () => {
    if (saved) {
      syncForm(saved);
      setMessage('Unsaved changes discarded.');
    }
  };

  const isSiteWide = !projectId;

  return (
    <Page
      eyebrow="Operations"
      title="Settings"
      lead="Operational policies, enforcement controls, and project preferences."
      actions={
        <Button isDisabled={busy} onClick={load}>
          Reload settings
        </Button>
      }
    >
      <div className="va-stack">
        <Field
          label="Scope"
          hint={
            isSiteWide
              ? 'Site-wide defaults apply to all projects unless explicitly overridden.'
              : 'Configuring project-specific overrides for this Jira project.'
          }
        >
          <Select
            value={projectId}
            disabled={busy}
            onChange={(val) => {
              setProject(val);
            }}
            placeholder="Site-wide default settings (All projects)"
            options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.key})` }))}
          />
        </Field>

        {error && (
          <Notice danger>
            {error} <Button isDisabled={busy} onClick={load}>Retry</Button>
          </Notice>
        )}
        {message && !error && <Notice>{message}</Notice>}

        {!saved && !error && <Loading label="Loading configuration…" />}

        {saved && (
          <>
            <Card
              title="Protection & Enforcement"
              subtitle={
                isSiteWide
                  ? 'Instance-wide activation state for VAtlassian validation'
                  : 'Project-specific activation override'
              }
            >
              <div className="va-stack va-stack--tight">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={enabled}
                    onChange={(e) => {
                      setEnabled(e.target.checked);
                      setMessage('');
                    }}
                  />
                  <strong>Enable VAtlassian protection</strong>
                </label>
                <p className="va-muted" style={{ margin: 0 }}>
                  When enabled, controlled transitions require eligible electronic signatures and content changes
                  against baselines are tracked. When disabled, workflow transitions proceed without VAtlassian
                  validator blocks.
                </p>
              </div>
            </Card>

            <Card
              title="Audit & Evidence Visibility"
              subtitle="Controls who may inspect signatures, baseline provenance, and drift evidence"
            >
              <div className="va-stack">
                <Field
                  label="Panel visibility boundary"
                  hint="In regulated Part 11 / GxP environments, restrict evidence to qualified reviewers and administrators."
                >
                  <Select
                    value={visibility}
                    disabled={busy}
                    placeholder="Choose visibility…"
                    onChange={(val) => {
                      if (val) {
                        setVisibility(val as 'reviewer-only' | 'all');
                        setMessage('');
                      }
                    }}
                    options={[
                      {
                        value: 'reviewer-only',
                        label: 'Reviewers and administrators only (Recommended for compliance)'
                      },
                      { value: 'all', label: 'All users with Jira browse permission' }
                    ]}
                  />
                </Field>

                <Field
                  label="Review queue threshold"
                  hint="Minimum materiality required for detected drift to enter the My Approvals worklist."
                >
                  <Select
                    value={queueThreshold}
                    disabled={busy}
                    placeholder="Choose threshold…"
                    onChange={(val) => {
                      if (val) {
                        setQueueThreshold(val as 'COSMETIC' | 'MINOR' | 'MAJOR' | 'CRITICAL');
                        setMessage('');
                      }
                    }}
                    options={[
                      { value: 'COSMETIC', label: 'Cosmetic (All changes including whitespace and formatting)' },
                      { value: 'MINOR', label: 'Minor (Standard field and content changes — recommended)' },
                      { value: 'MAJOR', label: 'Major (Significant status, parent, and structural changes)' },
                      { value: 'CRITICAL', label: 'Critical (High-risk alterations only)' }
                    ]}
                  />
                </Field>
              </div>
            </Card>

            <Card
              title="AI Assistance"
              subtitle="Used for automated field classification suggestions and change report generation"
            >
              <div className="va-stack">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={aiEnabled}
                    onChange={(e) => {
                      setAiEnabled(e.target.checked);
                      setMessage('');
                    }}
                  />
                  <strong>Enable AI assistance</strong>
                </label>
                <p className="va-muted" style={{ margin: 0 }}>
                  Provides automated field suggestions in Controlled Fields and plain-English change reports in the
                  review workspace. When disabled, deterministic rule-based algorithms are used. Decisions always
                  require human reviewer authentication.
                </p>

                {aiEnabled && (
                  <Field
                    label="Max completion tokens"
                    hint="Token budget allocated per AI classification or report request (256 to 16,384)."
                  >
                    <input
                      className="va-input"
                      type="number"
                      min={256}
                      max={16384}
                      step={256}
                      disabled={busy}
                      value={maxTokens}
                      onChange={(e) => {
                        setMaxTokens(Math.max(256, Math.min(16384, Number(e.target.value) || 256)));
                        setMessage('');
                      }}
                      style={{ maxWidth: '200px' }}
                    />
                  </Field>
                )}
              </div>
            </Card>

            <Card
              title="Restoration & Remediation"
              subtitle="Automated rollback behavior when unapproved drift is rejected"
            >
              <div className="va-stack va-stack--tight">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={commentOnRestore}
                    onChange={(e) => {
                      setCommentOnRestore(e.target.checked);
                      setMessage('');
                    }}
                  />
                  <strong>Post audit comment on restoration</strong>
                </label>
                <p className="va-muted" style={{ margin: '0 0 12px 24px' }}>
                  Automatically adds an audit comment to the Jira work item documenting which fields were restored to
                  the approved baseline.
                </p>

                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={notifyUsersOnRestore}
                    onChange={(e) => {
                      setNotifyUsersOnRestore(e.target.checked);
                      setMessage('');
                    }}
                  />
                  <strong>Notify authors of unapproved modifications</strong>
                </label>
                <p className="va-muted" style={{ margin: '0 0 0 24px' }}>
                  Sends an email/in-app notification to users whose unapproved edits were reverted during baseline
                  restoration.
                </p>
              </div>
            </Card>

            <Card title="Enforcement Architecture">
              <div className="va-stack va-stack--tight">
                <div className="va-row">
                  <Badge tone="brand">DETECT MODE</Badge>
                  <span className="va-muted">Content change detection with workflow transition gates</span>
                </div>
                <p className="va-muted" style={{ margin: 0 }}>
                  Content changes to approved work items are detected asynchronously and recorded with cryptographic
                  evidence. Controlled transitions are enforced synchronously by Jira workflow validators configured in
                  Controlled transitions.
                </p>
                {saved.config.policy?.mode === 'STRICT' && (
                  <Notice danger>
                    This configuration contains a legacy STRICT setting that does not enforce content locking. Saving
                    settings will update it to the supported DETECT policy.
                  </Notice>
                )}
              </div>
            </Card>

            <div className="va-row" style={{ marginTop: '8px' }}>
              <Button appearance="primary" isDisabled={busy || !isDirty} onClick={save}>
                {busy ? 'Saving…' : 'Save settings'}
              </Button>
              {isDirty && (
                <Button isDisabled={busy} onClick={handleReset}>
                  Discard changes
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Page>
  );
}

