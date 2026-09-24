import { useCallback, useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import { Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';

export default function ConfluenceProtectAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const protect = useCallback(async () => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      assertResult(await invoke<Result>('confluence:protectPage'));
      setSuccess('Page successfully protected. Baseline created.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Page title="Protect with VAtlassian">
      <div className="va-stack">
        <p>This will establish a baseline for the page content and restrict editing to authorized approvals.</p>
        {error && <Notice danger>{error}</Notice>}
        {success && <Notice>{success}</Notice>}
        {!success && (
          <Button appearance="primary" isDisabled={busy} onClick={protect}>
            {busy ? 'Protecting...' : 'Protect Page'}
          </Button>
        )}
      </div>
    </Page>
  );
}
