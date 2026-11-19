import { lazy, Suspense, useEffect, useState } from 'react';
import { hasAuth0Configuration } from './auth/AuthProvider';
import ChangePasswordPage, { LogoutPage, SignedOutPage } from './features/account/AccountPages';
import { AppShell, type Section } from './components/layout/AppShell';
import type { AdminSection } from './features/administration/AdministrationPage';
import { projectRoute } from './features/dashboard/projectRoutes';
import type { Editor } from './features/dashboard/WorkspaceEditor';
import { clearNotificationWorkspace } from './features/notifications/api';
import { dashboardRequest, type Dashboard } from './features/dashboard/data';

const ProfilePage = lazy(() => import('./features/account/ProfilePage'));
const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage'));
const AdministrationPage = lazy(() => import('./features/administration/AdministrationPage'));
const NotificationsPage = lazy(() => import('./features/notifications/NotificationsPage'));
const UsersPage = lazy(() => import('./features/users/UsersPage'));
const UserDetailPage = lazy(() => import('./features/users/UsersPage').then((module) => ({ default: module.UserDetailPage })));
const ImportTasks = lazy(() => import('./features/task-import/TaskImportsPage').then((module) => ({ default: module.ImportTasks })));
const ImportHistory = lazy(() => import('./features/task-import/TaskImportsPage').then((module) => ({ default: module.ImportHistory })));

const routeToSection: Record<string, Section> = {
  '/dashboard': 'Dashboard', '/projects': 'Projects', '/tasks': 'My tasks', '/board': 'Board', '/timeline': 'Timeline', '/team': 'Team', '/users': 'Users', '/admin/users': 'Users', '/admin/organization': 'Organization', '/admin/departments': 'Departments', '/admin/roles': 'Roles & permissions', '/admin/audit': 'Audit logs', '/notifications': 'Notifications', '/imports/new': 'Import tasks', '/imports/history': 'Import history', '/account/profile': 'My profile', '/account/password': 'Change password', '/account/logout': 'Logout',
};
const sectionToRoute: Record<Section, string> = {
  Dashboard: '/dashboard', Projects: '/projects', 'My tasks': '/tasks', Board: '/board', Timeline: '/timeline', Team: '/team', Users: '/users', Organization: '/admin/organization', Departments: '/admin/departments', 'Roles & permissions': '/admin/roles', 'Audit logs': '/admin/audit', Notifications: '/notifications', 'Import tasks': '/imports/new', 'Import history': '/imports/history', 'My profile': '/account/profile', 'Change password': '/account/password', Logout: '/account/logout',
};

const administration: Partial<Record<Section, AdminSection>> = {
  Organization: 'organization', Departments: 'departments', 'Roles & permissions': 'roles', 'Audit logs': 'audit',
};

const localSignOutKey = 'flowdeck.local-signed-out';

export default function App() {
  const [signedOut, setSignedOut] = useState(() => window.location.pathname === '/signed-out' ||
    (!hasAuth0Configuration() && sessionStorage.getItem(localSignOutKey) === 'true'));

  useEffect(() => {
    const syncSignOut = () => setSignedOut(window.location.pathname === '/signed-out' ||
      (!hasAuth0Configuration() && sessionStorage.getItem(localSignOutKey) === 'true'));
    window.addEventListener('popstate', syncSignOut);
    return () => window.removeEventListener('popstate', syncSignOut);
  }, []);

  if (signedOut) return <SignedOutPage onResumeDemo={() => {
    sessionStorage.removeItem(localSignOutKey);
    window.history.replaceState({}, '', '/dashboard');
    setSignedOut(false);
  }} />;
  return <WorkspaceApp onLocalLogout={() => {
    clearNotificationWorkspace();
    sessionStorage.setItem(localSignOutKey, 'true');
    window.history.replaceState({}, '', '/signed-out');
    setSignedOut(true);
  }} />;
}

function WorkspaceApp({ onLocalLogout }: { onLocalLogout: () => void }) {
  const [pathname, setPathname] = useState(window.location.pathname);
  const memberId = /^\/admin\/users\/([^/]+)\/?$/.exec(pathname)?.[1];
  const selectedProject = projectRoute(pathname);
  const active = memberId ? 'Users' : selectedProject?.view === 'board' ? 'Board' :
    selectedProject?.view === 'timeline' ? 'Timeline' : selectedProject ? 'Projects' : routeToSection[pathname] ?? 'Dashboard';
  const adminSection = administration[active];
  const [unreadCount, setUnreadCount] = useState<number>();
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [logoutReturnPath, setLogoutReturnPath] = useState('/dashboard');

  useEffect(() => {
    const handlePopState = () => {
      setPathname(window.location.pathname);
      setEditor(undefined);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLElement && Boolean(event.target.closest('input, textarea, select, [contenteditable]'));
      const slash = event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (slash || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.global-search input')?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigate = (section: Section) => {
    setEditor(undefined);
    const nextPath = sectionToRoute[section];
    if (section === 'Logout' && pathname !== nextPath) setLogoutReturnPath(pathname);
    setPathname(nextPath);
    if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
  };

  const [dashboard, setDashboard] = useState<Dashboard>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    dashboardRequest<Dashboard>('', { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setDashboard(data);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not load workspace data.');
    });
    return () => controller.abort();
  }, [attempt]);

  const retry = () => {
    setError('');
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    if (!dashboard || hasAuth0Configuration() || active === 'Notifications') return;
    const controller = new AbortController();
    dashboardRequest<{ count: number }>('/unread-notifications', { signal: controller.signal }).then(({ count }) => {
      if (!controller.signal.aborted) setUnreadCount(count);
    }).catch(() => {});
    return () => controller.abort();
  }, [dashboard, active]);

  const refreshWorkspace = () => {
    void dashboardRequest<Dashboard>().then(setDashboard).catch(() => {});
  };

  return (
    <AppShell active={active} projectContext={Boolean(selectedProject)} searchValue={search} onSearchChange={setSearch} onNavigate={navigate}
      onCreateTask={dashboard?.projects.length &&
        (!selectedProject || dashboard.projects.some(({ id }) => id === selectedProject.id)) ? () => {
        if (adminSection || active === 'My profile' || active === 'Logout' || active === 'Change password' || active === 'Users' || active === 'Notifications' || active === 'Import tasks' || active === 'Import history') navigate('My tasks');
        setEditor({ kind: 'tasks', projectId: selectedProject?.id });
      } : undefined}
      workspaceName={dashboard?.workspaceName} displayName={dashboard?.displayName}
      role={dashboard?.role} canViewAdministration={dashboard?.canViewAdministration} userId={dashboard?.userId} unreadCount={unreadCount}
      onUnreadCount={setUnreadCount}>
      <Suspense fallback={<p role="status">Loading page…</p>}>
      {active === 'My profile' ? <ProfilePage onSave={refreshWorkspace} /> :
        active === 'Change password' ? <ChangePasswordPage onProfile={() => navigate('My profile')} /> :
        active === 'Logout' ? <LogoutPage onLocalLogout={onLocalLogout}
          onCancel={() => {
            window.history.replaceState({}, '', logoutReturnPath);
            setPathname(logoutReturnPath);
          }} /> :
        adminSection ? <AdministrationPage key={adminSection} section={adminSection} members={dashboard?.members ?? []} search={search} /> :
        active === 'Import history' ? <ImportHistory /> :
        active === 'Import tasks' && dashboard ? <ImportTasks projects={dashboard.projects}
          onComplete={async () => setDashboard(await dashboardRequest<Dashboard>())} /> :
        active === 'Notifications' ? <NotificationsPage onUnreadCount={setUnreadCount} /> :
        memberId ? <UserDetailPage key={memberId} memberId={memberId} onChange={refreshWorkspace} /> :
        active === 'Users' ? <UsersPage search={search} onChange={refreshWorkspace} /> : dashboard ? (
        <DashboardPage selectedProject={selectedProject} search={search} view={active} onNavigate={navigate} dashboard={dashboard} setDashboard={setDashboard} editor={editor} setEditor={setEditor} />
      ) : (
        <section className="empty-state">
          {error ? <><p role="alert">{error}</p><button className="button button--secondary" onClick={retry}>Retry</button></>
            : <p role="status">Loading workspace data…</p>}
        </section>
      )}
      </Suspense>
    </AppShell>
  );
}
