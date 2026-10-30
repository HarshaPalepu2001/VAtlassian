import { useState, useEffect } from 'react';
import { subscribeHarnessEvents, getHarnessEvents, type HarnessEvent, type HarnessCategory } from '../lib/harness';
import { invoke } from '../lib/bridge';
import type { PanelSummary, PanelEvidence } from './types';

interface ServerDiagnosticsResult {
  ok: boolean;
  verdict?: string;
  remediations?: string[];
  issue?: {
    id: number;
    key: string;
    summary?: string;
    status?: string;
    issueType?: string;
    project?: string;
  };
  gateSimulation?: {
    projectDisabled: boolean;
    itemState: string;
    driftCount: number;
    storedDriftCount?: number;
    driftSource?: 'LIVE' | 'STORED_COUNTER';
    counterDisagrees?: boolean;
    workitemHeld: boolean;
    holdReason: string | null;
    activeControlledTransitions: number;
    applicableTransitions?: Array<{
      issueTypeId?: string | null;
      appliesToThisIssue?: boolean;
      transitionId: string;
      fromStatusId: string;
      toStatusId: string;
      requiredRole: string;
      requiredAssurance: string;
      captureBaseline: boolean;
    }>;
  };
  liveDrift?: {
    checked: boolean;
    reason?: string | null;
    error?: string;
    changedCount?: number;
    changed?: string[];
    scope?: { source: string; issueTypeId: string; rootIssueId: number | null } | null;
    diagnostics?: {
      cause: 'BASELINE_UNREADABLE' | 'DIGEST_MISMATCH' | null;
      digestSource?: string;
      rootDigestError?: string | null;
      baselineReadable?: boolean;
      baselineKeyCount?: number;
      currentKeyCount?: number;
      scopeFieldCount?: number;
      baselineVersion?: number | null;
      baselineIssueTypeId?: string | null;
      fields?: Array<{ field: string; baseline: string | null; current: string | null }>;
    } | null;
  };
  typeCheck?: {
    issueTypeId: string | null;
    issueTypeName: string | null;
    baselineIssueTypeId: string | null;
    typeChangedSinceBaseline: boolean;
  };
  baseline?: {
    baselineId: string;
    version: number;
    issueTypeId?: string | null;
    requiredAssurance?: string | null;
    transitionId?: string | null;
    approverName: string;
    treeHash: string;
    edgeCount: number;
    nodeCount: number;
    capturedAt: number;
  } | null;
  childBaselines?: Array<{
    issueId: number;
    version: number;
    contentHash: string;
    capturedAt: number;
  }>;
  vault?: {
    storage?: string;
    attachmentCount: number;
    attachments?: Array<{
      jiraAttachmentId: string;
      filename: string;
      contentHash: string;
      storage?: string;
      objectKey?: string | null;
      mediaId?: string | null;
      vaultedAt: number;
    }>;
  };
  drift?: {
    treeDriftCount: number;
    items?: unknown[];
  };
  approvals?: Array<{
    approvalId: string;
    decision: string;
    state: string;
    assuranceLevel: string;
    meaning: string;
    signerRole: string;
    decidedAt: number;
  }>;
  restores?: Array<{
    restoreId: string;
    state: string;
    totalSteps: number;
    completedSteps: number;
    lastError: string | null;
    unmatched?: unknown[];
    refused?: unknown[];
  }>;
  recentAudit?: Array<{
    event_id: number;
    event_type: string;
    actor_account_id: string;
    occurred_at: string;
  }>;
  error?: string;
}

export default function DiagnosticsHud({
  summary,
  evidence
}: {
  summary?: PanelSummary | null;
  evidence?: PanelEvidence | null;
}) {
  const [events, setEvents] = useState<HarnessEvent[]>(() => getHarnessEvents());
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'telemetry' | 'server'>('telemetry');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  // Server diagnostics state
  const [serverDiag, setServerDiag] = useState<ServerDiagnosticsResult | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeHarnessEvents(allEvents => {
      if (!isPaused) {
        setEvents(allEvents);
      }
    });
  }, [isPaused]);

  const latest = events[events.length - 1];

  async function runServerDiagnostics() {
    const issueKeyOrId = summary?.issue?.key || summary?.issue?.id;
    if (!issueKeyOrId) {
      setDiagError('No active issue found to inspect');
      return;
    }
    setDiagLoading(true);
    setDiagError(null);
    try {
      const res = await invoke<ServerDiagnosticsResult>('harness:inspectIssue', {
        issueKey: summary?.issue?.key,
        issueId: summary?.issue?.id
      });
      if (res && res.ok !== false) {
        setServerDiag(res);
      } else {
        setDiagError(res?.error || 'Inspection failed');
      }
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagLoading(false);
    }
  }

  function copyReport() {
    const fullReport = {
      timestamp: new Date().toISOString(),
      issue: {
        key: summary?.issue?.key,
        id: summary?.issue?.id,
        status: summary?.issue?.status?.name
      },
      baseline: summary?.baseline ? {
        id: summary.baseline.baselineId,
        version: summary.baseline.version,
        approver: summary.baseline.approvedName,
        capturedAt: summary.baseline.capturedAt
      } : null,
      drift: {
        count: summary?.drift?.count,
        materialCount: summary?.drift?.materialCount,
        evidenceHash: evidence?.evidenceHash
      },
      approval: {
        requiredRole: summary?.approval?.requiredRole,
        requiredAssurance: summary?.approval?.requiredAssurance,
        pending: summary?.approval?.pending
      },
      restore: summary?.restore,
      serverDiagnostics: serverDiag,
      recentEvents: events.slice(-40)
    };

    navigator.clipboard.writeText(JSON.stringify(fullReport, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      prompt('Copy diagnostic bundle:', JSON.stringify(fullReport));
    });
  }

  const categoryColor: Record<string, string> = {
    UI: '#0052cc',
    BRIDGE: '#6554c0',
    WEBAUTHN: '#00875a',
    DRIFT: '#ff8b00',
    RESTORE: '#00b8d9',
    GATE: '#ffab00',
    VAULT: '#8777d9',
    DIAGNOSTICS: '#00a3bf',
    RESOLVER: '#0052cc',
    ADMIN: '#0747a6',
    CAPTURE: '#00a3bf',
    APPROVAL: '#36b37e',
    ERROR: '#de350b'
  };

  const filteredEvents = events.filter(e => {
    if (selectedCategory !== 'ALL' && e.category !== selectedCategory) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchAction = e.action.toLowerCase().includes(q);
      const matchDetails = JSON.stringify(e.details || {}).toLowerCase().includes(q);
      if (!matchAction && !matchDetails) return false;
    }
    return true;
  });

  const categoriesAvailable: Array<HarnessCategory | 'ALL'> = [
    'ALL',
    'ERROR',
    'GATE',
    'BRIDGE',
    'WEBAUTHN',
    'DRIFT',
    'RESTORE',
    'VAULT'
  ];

  const verdictColor: Record<string, { bg: string; text: string; border: string }> = {
    HEALTHY: { bg: '#e3fcef', text: '#006644', border: '#abf5d1' },
    BASELINE_UNREADABLE: { bg: '#ffebe6', text: '#de350b', border: '#ffbdad' },
    DRIFT_PENDING_REVIEW: { bg: '#fffae6', text: '#ff8b00', border: '#ffe380' },
    BUSY_RESTORING: { bg: '#deebff', text: '#0747a6', border: '#b3d4ff' },
    RECORD_LOCKED: { bg: '#ffebe6', text: '#de350b', border: '#ffbdad' },
    RESTORE_INCOMPLETE: { bg: '#ffebe6', text: '#de350b', border: '#ffbdad' },
    NO_BASELINE: { bg: '#eae6ff', text: '#403294', border: '#c0b6f2' }
  };

  // Folded, it is one quiet link at the foot of the panel.
  if (!open) {
    return (
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="va-link-button" style={{ fontSize: 12 }} onClick={() => setOpen(true)}>Diagnostics</button>
      </div>
    );
  }

  return (
    <aside
      aria-label="VAtlassian Observability Harness"
      style={{
        marginTop: 16,
        padding: '10px 14px',
        background: '#f4f5f7',
        border: '1px solid #dfe1e6',
        borderRadius: 5,
        fontSize: 12
      }}
    >
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <span style={{ fontWeight: 700, color: '#172b4d' }}>⚡ Harness:</span>
          {latest ? (
            <span
              style={{
                display: 'inline-block',
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: categoryColor[latest.category] || '#172b4d',
                fontFamily: 'monospace'
              }}
            >
              [{latest.category}] {latest.action}
              {latest.durationMs !== undefined ? ` (${latest.durationMs}ms)` : ''}
            </span>
          ) : (
            <span style={{ color: '#6b778c' }}>Ready. Listening for actions...</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            onClick={copyReport}
            style={{
              background: copied ? '#e3fcef' : '#ebecf0',
              color: copied ? '#006644' : '#42526e',
              border: '1px solid #c1c7d0',
              borderRadius: 3,
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            {copied ? '✓ Copied bundle' : 'Copy report'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              background: '#0052cc',
              border: 'none',
              color: '#fff',
              borderRadius: 3,
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600
            }}
          >
            {open ? 'Hide HUD' : `Diagnostics HUD (${events.length})`}
          </button>
        </div>
      </div>

      {/* Expanded HUD panel */}
      {open && (
        <div style={{ marginTop: 10, borderTop: '1px solid #dfe1e6', paddingTop: 10 }}>
          {/* Mode tabs */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                onClick={() => setActiveTab('telemetry')}
                style={{
                  background: activeTab === 'telemetry' ? '#0052cc' : '#ebecf0',
                  color: activeTab === 'telemetry' ? '#fff' : '#42526e',
                  border: 'none',
                  borderRadius: 3,
                  padding: '3px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Live telemetry ({filteredEvents.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('server');
                  if (!serverDiag) void runServerDiagnostics();
                }}
                style={{
                  background: activeTab === 'server' ? '#0052cc' : '#ebecf0',
                  color: activeTab === 'server' ? '#fff' : '#42526e',
                  border: 'none',
                  borderRadius: 3,
                  padding: '3px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Server diagnostics
              </button>
            </div>
            <span style={{ color: '#6b778c', fontSize: 11 }}>
              Issue: <strong>{summary?.issue?.key || 'N/A'}</strong>
            </span>
          </div>

          {/* Tab 1: live telemetry */}
          {activeTab === 'telemetry' && (
            <div>
              {/* Category filters and controls */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {categoriesAvailable.map(cat => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      style={{
                        background: selectedCategory === cat ? (categoryColor[cat] || '#0052cc') : '#ebecf0',
                        color: selectedCategory === cat ? '#fff' : '#42526e',
                        border: 'none',
                        borderRadius: 3,
                        padding: '2px 6px',
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="Filter actions..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    style={{
                      padding: '2px 6px',
                      fontSize: 11,
                      border: '1px solid #c1c7d0',
                      borderRadius: 3,
                      width: 110
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setIsPaused(!isPaused)}
                    style={{
                      background: isPaused ? '#fffae6' : '#ebecf0',
                      color: isPaused ? '#ff8b00' : '#42526e',
                      border: '1px solid #c1c7d0',
                      borderRadius: 3,
                      padding: '2px 6px',
                      fontSize: 10,
                      cursor: 'pointer'
                    }}
                  >
                    {isPaused ? '▶ Resume' : '⏸ Pause'}
                  </button>
                </div>
              </div>

              {/* Event list */}
              <div
                style={{
                  maxHeight: 220,
                  overflowY: 'auto',
                  background: '#091e4208',
                  padding: 6,
                  borderRadius: 4,
                  fontFamily: 'monospace',
                  fontSize: 11
                }}
              >
                {filteredEvents.length === 0 ? (
                  <div style={{ color: '#6b778c', padding: 8, textAlign: 'center' }}>
                    No events match the selected criteria.
                  </div>
                ) : (
                  filteredEvents.slice(-30).reverse().map(e => {
                    const isExpanded = expandedEventId === e.id;
                    return (
                      <div
                        key={e.id}
                        style={{
                          padding: '4px 2px',
                          borderBottom: '1px dotted #dfe1e6',
                          cursor: 'pointer'
                        }}
                        onClick={() => setExpandedEventId(isExpanded ? null : e.id)}
                      >
                        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                          <span style={{ color: '#8993a4', flexShrink: 0, fontSize: 10 }}>
                            {e.timestamp.slice(11, 19)}
                          </span>
                          <span
                            style={{
                              background: categoryColor[e.category] || '#42526e',
                              color: '#fff',
                              padding: '1px 5px',
                              borderRadius: 2,
                              fontSize: 9,
                              fontWeight: 700,
                              flexShrink: 0
                            }}
                          >
                            {e.category}
                          </span>
                          <span style={{ fontWeight: 600, color: e.error ? '#de350b' : '#172b4d', flexGrow: 1 }}>
                            {e.action}
                          </span>
                          {e.durationMs !== undefined && (
                            <span style={{ color: '#6b778c', fontSize: 10 }}>
                              {e.durationMs}ms
                            </span>
                          )}
                          {e.error && (
                            <span style={{ color: '#de350b', fontStyle: 'italic', fontSize: 10 }}>
                              ({e.error})
                            </span>
                          )}
                        </div>

                        {/* Expanded event details */}
                        {isExpanded && (
                          <div
                            style={{
                              marginTop: 4,
                              padding: 6,
                              background: '#fff',
                              border: '1px solid #dfe1e6',
                              borderRadius: 3,
                              fontSize: 10,
                              whiteSpace: 'pre-wrap',
                              overflowX: 'auto',
                              color: '#333'
                            }}
                          >
                            <div style={{ fontWeight: 700, marginBottom: 2 }}>Event payload:</div>
                            {JSON.stringify(e.details, null, 2)}
                            {e.traceId && (
                              <div style={{ marginTop: 4, color: '#6b778c' }}>
                                Trace ID: <code>{e.traceId}</code>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Tab 2: server diagnostics */}
          {activeTab === 'server' && (
            <div style={{ fontSize: 11 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, color: '#42526e' }}>Server state and gate evaluation</span>
                <button
                  type="button"
                  onClick={runServerDiagnostics}
                  disabled={diagLoading}
                  style={{
                    background: '#0052cc',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 3,
                    padding: '2px 8px',
                    fontSize: 11,
                    cursor: diagLoading ? 'wait' : 'pointer',
                    fontWeight: 600
                  }}
                >
                  {diagLoading ? 'Refreshing...' : 'Refresh diagnostics'}
                </button>
              </div>

              {diagError && (
                <div style={{ padding: 6, background: '#ffebe6', color: '#de350b', borderRadius: 3, marginBottom: 8 }}>
                  Error: {diagError}
                </div>
              )}

              {serverDiag && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {/* Health verdict card */}
                  {serverDiag.verdict && (
                    <div
                      style={{
                        padding: '6px 10px',
                        background: verdictColor[serverDiag.verdict]?.bg || '#f4f5f7',
                        color: verdictColor[serverDiag.verdict]?.text || '#172b4d',
                        border: `1px solid ${verdictColor[serverDiag.verdict]?.border || '#dfe1e6'}`,
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div>
                        <strong>Verdict:</strong> {serverDiag.verdict}
                        {(serverDiag.remediations ?? []).map(text => (
                          <div key={text} style={{ fontSize: 10, marginTop: 2 }}>{text}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Grid details */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {/* Baseline information */}
                    <div style={{ padding: 6, background: '#fff', border: '1px solid #dfe1e6', borderRadius: 3 }}>
                      <strong>Active baseline:</strong>
                      {serverDiag.baseline ? (
                        <div style={{ marginTop: 2 }}>
                          <div>Version: <strong>v{serverDiag.baseline.version}</strong></div>
                          <div>Approver: {serverDiag.baseline.approverName || 'N/A'}</div>
                          <div>Nodes: {serverDiag.baseline.nodeCount} | Edges: {serverDiag.baseline.edgeCount}</div>
                          <div>Captured as type: {serverDiag.baseline.issueTypeId ?? 'N/A'}{serverDiag.baseline.requiredAssurance ? ` · ${serverDiag.baseline.requiredAssurance}` : ''}</div>
                        </div>
                      ) : (
                        <div style={{ color: '#6b778c', marginTop: 2 }}>None captured</div>
                      )}
                    </div>

                    {/* Gate simulation */}
                    <div style={{ padding: 6, background: '#fff', border: '1px solid #dfe1e6', borderRadius: 3 }}>
                      <strong>Workflow gate:</strong>
                      {serverDiag.gateSimulation ? (
                        <div style={{ marginTop: 2 }}>
                          <div>Status: {serverDiag.gateSimulation.workitemHeld ? (
                            <span style={{ color: '#de350b', fontWeight: 600 }}>HELD ({serverDiag.gateSimulation.holdReason})</span>
                          ) : (
                            <span style={{ color: '#006644', fontWeight: 600 }}>CLEAR</span>
                          )}</div>
                          <div>
                            Drift: <strong>{serverDiag.gateSimulation.driftCount}</strong>{' '}
                            ({serverDiag.gateSimulation.driftSource === 'LIVE' ? 'live check' : 'stored counter only'}
                            {serverDiag.gateSimulation.storedDriftCount != null ? `, stored ${serverDiag.gateSimulation.storedDriftCount}` : ''})
                          </div>
                          {serverDiag.gateSimulation.counterDisagrees && (
                            <div style={{ color: '#de350b', fontWeight: 600 }}>Stored counter and live check disagree</div>
                          )}
                          <div>Controlled transitions: {serverDiag.gateSimulation.activeControlledTransitions}</div>
                          {(serverDiag.gateSimulation.applicableTransitions ?? []).map(rule => (
                            <div
                              key={`${rule.issueTypeId}-${rule.transitionId}-${rule.fromStatusId}`}
                              style={{ color: rule.appliesToThisIssue ? '#172b4d' : '#6b778c', fontWeight: rule.appliesToThisIssue ? 600 : 400 }}
                            >
                              {rule.appliesToThisIssue ? '▶ ' : '· '}type {rule.issueTypeId ?? '?'} · t{rule.transitionId} · {rule.requiredAssurance}
                              {rule.appliesToThisIssue ? ' (applies to this item)' : ''}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ color: '#6b778c', marginTop: 2 }}>Not evaluated</div>
                      )}
                    </div>

                    {/* Vault: Forge Object Store */}
                    <div style={{ padding: 6, background: '#fff', border: '1px solid #dfe1e6', borderRadius: 3 }}>
                      <strong>Vault:</strong>
                      {serverDiag.vault ? (
                        <div style={{ marginTop: 2 }}>
                          <div>Storage: Forge Object Store</div>
                          <div>Vaulted files: {serverDiag.vault.attachmentCount}</div>
                          {(serverDiag.vault.attachments ?? []).slice(0, 5).map(a => (
                            <div key={`${a.jiraAttachmentId}-${a.vaultedAt}`} style={{ color: '#6b778c' }}>
                              {a.filename}: {a.storage ?? 'OBJECT_STORE'}{a.mediaId ? '' : ', no media id'}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ color: '#6b778c', marginTop: 2 }}>Not vaulted</div>
                      )}
                    </div>

                    {/* Drift and child status */}
                    <div style={{ padding: 6, background: '#fff', border: '1px solid #dfe1e6', borderRadius: 3 }}>
                      <strong>Hierarchy and drift:</strong>
                      <div style={{ marginTop: 2 }}>
                        <div>Tree drift: {serverDiag.drift?.treeDriftCount ?? 0} items</div>
                        <div>Child baselines: {serverDiag.childBaselines?.length ?? 0} children</div>
                      </div>
                    </div>
                  </div>

                  {/* The live check the validator, signing form and panel header hold on */}
                  <div style={{ padding: 6, background: '#fff', border: '1px solid #dfe1e6', borderRadius: 3 }}>
                    <strong>Live drift check</strong>
                    {serverDiag.typeCheck && (
                      <div style={{ marginTop: 2, color: serverDiag.typeCheck.typeChangedSinceBaseline ? '#de350b' : '#172b4d', fontWeight: serverDiag.typeCheck.typeChangedSinceBaseline ? 600 : 400 }}>
                        Type now: {serverDiag.typeCheck.issueTypeName ?? serverDiag.typeCheck.issueTypeId} ({serverDiag.typeCheck.issueTypeId})
                        {' · '}baseline captured as: {serverDiag.typeCheck.baselineIssueTypeId ?? 'N/A'}
                        {serverDiag.typeCheck.typeChangedSinceBaseline ? '. Type changed since baseline' : ''}
                      </div>
                    )}
                    {serverDiag.liveDrift?.checked ? (
                      <div style={{ marginTop: 2 }}>
                        <div>
                          Flagged: <strong>{serverDiag.liveDrift.changedCount}</strong> field(s)
                          {serverDiag.liveDrift.diagnostics?.cause ? ` · cause ${serverDiag.liveDrift.diagnostics.cause}` : ''}
                        </div>
                        <div style={{ color: '#6b778c' }}>
                          Baseline digests: {serverDiag.liveDrift.diagnostics?.digestSource ?? 'N/A'}
                          {' · '}{serverDiag.liveDrift.diagnostics?.baselineKeyCount ?? 0} baseline keys vs {serverDiag.liveDrift.diagnostics?.currentKeyCount ?? 0} live
                          {' · '}{serverDiag.liveDrift.diagnostics?.scopeFieldCount ?? 0} in scope
                        </div>
                        {serverDiag.liveDrift.scope && (
                          <div style={{ color: '#6b778c' }}>
                            Fields checked against: {serverDiag.liveDrift.scope.source === 'own' ? 'its own type' : `covering root ${serverDiag.liveDrift.scope.rootIssueId}`}
                            {' '}(type {serverDiag.liveDrift.scope.issueTypeId})
                          </div>
                        )}
                        {serverDiag.liveDrift.diagnostics?.rootDigestError && (
                          <div style={{ color: '#de350b' }}>Root digest read failed: {serverDiag.liveDrift.diagnostics.rootDigestError}</div>
                        )}
                        {(serverDiag.liveDrift.diagnostics?.fields ?? []).slice(0, 15).map(entry => (
                          <div key={entry.field} style={{ fontFamily: 'monospace', fontSize: 10 }}>
                            {entry.field}: {entry.baseline ?? 'none'} → {entry.current ?? 'none'}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color: '#6b778c', marginTop: 2 }}>
                        Not run: {serverDiag.liveDrift?.reason ?? 'unknown'}{serverDiag.liveDrift?.error ? ` (${serverDiag.liveDrift.error})` : ''}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
