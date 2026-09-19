import { useState, useEffect } from 'react';
import { subscribeHarnessEvents, getHarnessEvents, type HarnessEvent } from '../lib/harness';
import type { PanelSummary, PanelEvidence } from './types';

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

  useEffect(() => {
    return subscribeHarnessEvents(allEvents => {
      setEvents(allEvents);
    });
  }, []);

  const latest = events[events.length - 1];

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
      recentEvents: events.slice(-30)
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
    ERROR: '#de350b'
  };

  return (
    <aside
      aria-label="VAtlassian Observability Harness"
      style={{
        marginTop: 16,
        padding: '8px 12px',
        background: '#f4f5f7',
        border: '1px solid #dfe1e6',
        borderRadius: 4,
        fontSize: 12
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <span style={{ fontWeight: 600, color: '#42526e' }}>⚡ Harness:</span>
          {latest ? (
            <span
              style={{
                display: 'inline-block',
                maxWidth: 220,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: categoryColor[latest.category] || '#172b4d'
              }}
            >
              [{latest.category}] {latest.action}
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
            {copied ? '✓ Copied report' : 'Copy report'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#0052cc',
              cursor: 'pointer',
              fontSize: 11,
              textDecoration: 'underline'
            }}
          >
            {open ? 'Hide log' : `View log (${events.length})`}
          </button>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 8, borderTop: '1px solid #dfe1e6', paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, color: '#6b778c' }}>
            <span>Recent telemetry ({events.length} events buffered)</span>
            <span>Issue: {summary?.issue?.key || 'N/A'}</span>
          </div>
          <div
            style={{
              maxHeight: 180,
              overflowY: 'auto',
              background: '#091e4208',
              padding: 6,
              borderRadius: 3,
              fontFamily: 'monospace',
              fontSize: 11
            }}
          >
            {events.length === 0 ? (
              <div style={{ color: '#6b778c' }}>No events recorded yet. Click any button or run an action.</div>
            ) : (
              events.slice(-25).reverse().map(e => (
                <div
                  key={e.id}
                  style={{
                    padding: '2px 0',
                    borderBottom: '1px dotted #ebecf0',
                    display: 'flex',
                    gap: 6,
                    alignItems: 'baseline'
                  }}
                >
                  <span style={{ color: '#8993a4', flexShrink: 0 }}>
                    {e.timestamp.slice(11, 19)}
                  </span>
                  <span
                    style={{
                      background: categoryColor[e.category] || '#42526e',
                      color: '#fff',
                      padding: '0 4px',
                      borderRadius: 2,
                      fontSize: 10,
                      fontWeight: 600,
                      flexShrink: 0
                    }}
                  >
                    {e.category}
                  </span>
                  <span style={{ fontWeight: 500, color: e.error ? '#de350b' : '#172b4d' }}>
                    {e.action}
                  </span>
                  {e.error && (
                    <span style={{ color: '#de350b', fontStyle: 'italic' }}>
                      ({e.error})
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
