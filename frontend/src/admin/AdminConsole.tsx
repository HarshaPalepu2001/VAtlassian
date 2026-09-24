import { useCallback, useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import { invoke } from '../lib/bridge';
import { Loading, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import type { Project } from './types';
import { parseAdminRoute } from './routes';
import type { AdminRoute } from './routes';
import AdminsPage from './pages/AdminsPage';
import RolesPage from './pages/RolesPage';
import TransitionsPage from './pages/TransitionsPage';
import FieldsPage from './pages/FieldsPage';
import LedgerPage from './pages/LedgerPage';
import RetentionPage from './pages/RetentionPage';
import CredentialsPage from './pages/CredentialsPage';
import HealthPage from './pages/HealthPage';
import ContentReviewPage from './pages/ContentReviewPage';
import SettingsPage from './pages/SettingsPage';

const NAV_ITEMS: { id: AdminRoute; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'admins', label: 'Administrators' },
  { id: 'roles', label: 'Approver roles' },
  { id: 'transitions', label: 'Controlled transitions' },
  { id: 'fields', label: 'Controlled fields' },
  { id: 'ledger', label: 'Audit ledger' },
  { id: 'retention', label: 'Export & retention' },
  { id: 'content-review', label: 'Content changes' },
  { id: 'credentials', label: 'Credentials & recovery' },
  { id: 'health', label: 'Control health' }
];

export default function AdminConsole({ configure = false }: { configure?: boolean }) {
  const [route, setRoute] = useState<AdminRoute | null>(configure ? 'settings' : 'admins');
  const [access, setAccess] = useState<{ isAdmin: boolean; isJiraAdmin?: boolean; needsBootstrap: boolean } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [projectError, setProjectError] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(false);

  useEffect(() => {
    if (configure) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    view
      .createHistory()
      .then((history) => {
        if (!active) return;
        setRoute(parseAdminRoute(history.location.pathname));
        unlisten = history.listen((location) => {
          setRoute(parseAdminRoute(location.pathname));
        });
      })
      .catch((e) => setError(errorMessage(e)));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [configure]);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true); setProjectError('');
    try {
      const p = assertResult(await invoke<Result & { projects: Project[] }>('admin:listProjects'));
      setProjects(p.projects);
    } catch (e) { setProjects([]); setProjectError(errorMessage(e)); }
    finally { setLoadingProjects(false); }
  }, []);
  const check = useCallback(async () => {
    setError('');
    try {
      const r = assertResult(await invoke<Result & { isAdmin: boolean; isJiraAdmin?: boolean; needsBootstrap: boolean }>('admin:check'));
      setAccess(r);
      if (r.isAdmin) void loadProjects();
    } catch (e) { setAccess(null); setError(errorMessage(e)); }
  }, [loadProjects]);

  useEffect(() => {
    void check();
  }, [check]);

  if (error) {
    return (
      <Page title="Could not load administration">
        <Notice danger>{error}</Notice>
        <button className="va-button" onClick={check}>
          Retry
        </button>
      </Page>
    );
  }

  if (!access) return <Loading label="Checking administrative access…" />;
  if (access.needsBootstrap && !access.isAdmin) {
    return <AdminsPage bootstrap onBootstrap={() => void check()} />;
  }
  // A Jira administrator owns the roster and nothing else. They get the
  // Administrators page so a roster can always be repaired from inside Jira,
  // and no control page at all — the resolvers refuse those regardless, but
  // offering a page that cannot work is its own kind of wrong answer.
  if (!access.isAdmin && access.isJiraAdmin) {
    return (
      <Page eyebrow="Setup" title="Administrators">
        <Notice>
          You are here as a Jira administrator. You can appoint and remove VAtlassian administrators.
          Approver roles, controlled transitions, controlled fields, evidence and settings are not yours to change:
          appoint yourself below if you need them.
        </Notice>
        <AdminsPage />
      </Page>
    );
  }
  if (!access.isAdmin) {
    return (
      <Page title="Administrator access required">
        <Notice>An existing VAtlassian administrator must grant access.</Notice>
      </Page>
    );
  }

  const renderContent = () => {
    const needsProjects = ['roles','transitions','fields','settings','health','retention','content-review'].includes(route ?? '');
    if (needsProjects && loadingProjects) return <Loading label="Loading projects…"/>;
    if (needsProjects && projectError) return <Page title="Project list unavailable"><Notice danger>{projectError}</Notice><button className="va-button" onClick={loadProjects}>Retry project list</button></Page>;
    switch (route) {
      case 'admins':
        return <AdminsPage />;
      case 'roles':
        return <RolesPage projects={projects} />;
      case 'transitions':
        return <TransitionsPage projects={projects} />;
      case 'fields':
        return <FieldsPage projects={projects} />;
      case 'ledger':
        return <LedgerPage />;
      case 'retention':
        return <RetentionPage projects={projects} />;
      case 'credentials':
        return <CredentialsPage />;
      case 'health':
        return <HealthPage projects={projects} />;
      case 'content-review':
        return <ContentReviewPage projects={projects} />;
      case 'settings':
        return <SettingsPage projects={projects} />;
      default:
        return (
          <Page title="Page not found">
            <p>Choose a page in the administration menu.</p>
          </Page>
        );
    }
  };

  if (!configure) return renderContent();

  return (
    <div className="va-admin-configure-layout" style={{ padding: '8px 0' }}>
      <nav className="va-nav-tabs" aria-label="Administration navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`va-nav-tab ${route === item.id ? 'va-nav-tab--active' : ''}`}
            onClick={() => setRoute(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {renderContent()}
    </div>
  );
}

