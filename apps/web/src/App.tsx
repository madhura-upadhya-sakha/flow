import { useEffect, useState } from 'react';
import { AppShell, type Section } from './components/layout/AppShell';
import DashboardPage from './features/dashboard/DashboardPage';
import { Icon } from './lib/icons';

const routeToSection: Record<string, Section> = {
  '/dashboard': 'Dashboard', '/projects': 'Projects', '/tasks': 'My tasks', '/board': 'Board', '/timeline': 'Timeline', '/team': 'Team',
};
const sectionToRoute: Record<Section, string> = {
  Dashboard: '/dashboard', Projects: '/projects', 'My tasks': '/tasks', Board: '/board', Timeline: '/timeline', Team: '/team',
};

export default function App() {
  const [active, setActive] = useState<Section>(routeToSection[window.location.pathname] ?? 'Dashboard');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const handlePopState = () => setActive(routeToSection[window.location.pathname] ?? 'Dashboard');
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.global-search input')?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigate = (section: Section) => {
    setActive(section);
    const nextPath = sectionToRoute[section];
    if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
  };

  return (
    <AppShell active={active} searchValue={search} onSearchChange={setSearch} onNavigate={navigate}>
      {active === 'Dashboard' ? <DashboardPage search={search} /> : <section className="coming-soon"><span className="coming-icon"><Icon name="spark" /></span><span className="eyebrow">FLOWDECK WORKSPACE</span><h1>{active}</h1><p>This view is part of the project structure and is ready for its screen implementation.</p><button type="button" className="button button--primary" onClick={() => navigate('Dashboard')}>Back to dashboard</button></section>}
    </AppShell>
  );
}
