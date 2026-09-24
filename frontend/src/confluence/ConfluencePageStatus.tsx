import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import Button from '@atlaskit/button';

export default function ConfluencePageStatus({ view }: { view: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [state, setState] = useState<{ status: string, message?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = assertResult(await invoke<Result & { status: string, message?: string }>('confluence:getPageStatus'));
      setState(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading label="Loading status..." />;

  const checkout = async () => {
    setLoading(true);
    try {
      await invoke('confluence:checkOut');
      await load();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  const isBanner = view === 'confluence-banner';
  const statusContent = () => {
    switch (state?.status) {
      case 'UNPROTECTED':
        return <Notice>Not protected yet. Eligible users can protect this page.</Notice>;
      case 'PROTECTED':
        return (
          <Notice>
            Protected. Normal edit paths are locked.
            <div style={{ marginTop: '8px' }}>
              <Button appearance="primary" onClick={checkout}>Check out</Button>
            </div>
          </Notice>
        );
      case 'WORKING_COPY':
        return <Notice>Working copy open. Changes are pending approval.</Notice>;
      case 'APPROVAL_PENDING':
        return <Notice>Approval pending. Review required to promote changes.</Notice>;
      case 'DRIFTED':
        return <Notice danger>Drifted. Unauthorized edit detected.</Notice>;
      case 'RESTORING':
        return <Notice>Restoring. Reverting unauthorized changes...</Notice>;
      case 'ERROR_LOCKED':
        return <Notice danger>Error locked. Admin recovery required.</Notice>;
      case 'DETECTION_ONLY':
        return <Notice>Detection only. Content will be monitored but not automatically restored.</Notice>;
      default:
        return <Notice>Unknown status.</Notice>;
    }
  };

  return (
    <div className="va-confluence-status" style={{ padding: isBanner ? '8px 16px' : '0' }}>
      {error && <Notice danger>{error}</Notice>}
      {!error && statusContent()}
    </div>
  );
}
