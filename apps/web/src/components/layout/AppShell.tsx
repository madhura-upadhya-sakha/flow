import { useState } from 'react';
import { Icon, type IconName } from '../../lib/icons';

export type Section = 'Dashboard' | 'Projects' | 'My tasks' | 'Board' | 'Timeline' | 'Team';

const links: { label: Section; icon: IconName }[] = [
  { label: 'Dashboard', icon: 'grid' },
  { label: 'Projects', icon: 'folder' },
  { label: 'My tasks', icon: 'check' },
  { label: 'Board', icon: 'board' },
  { label: 'Timeline', icon: 'calendar' },
  { label: 'Team', icon: 'users' },
];

type Props = {
  active: Section;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onNavigate: (section: Section) => void;
  children: import('react').ReactNode;
};

export function AppShell({ active, searchValue, onSearchChange, onNavigate, children }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const navigate = (section: Section) => {
    onNavigate(section);
    setMobileOpen(false);
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`} aria-label="Main navigation">
        <div className="brand"><span className="brand-mark"><span /></span><span>flowdeck</span></div>
        <button className="workspace-switch" type="button" aria-label="Current workspace: Acme Studio">
          <span className="workspace-avatar">A</span>
          <span className="workspace-copy"><strong>Acme Studio</strong><small>Workspace</small></span>
          <Icon name="chevron" className="workspace-chevron" />
        </button>
        <p className="nav-label">WORKSPACE</p>
        <nav className="primary-nav">
          {links.map(({ label, icon }) => (
            <button className={`nav-item ${active === label ? 'nav-item--active' : ''}`} key={label} type="button" onClick={() => navigate(label)} aria-current={active === label ? 'page' : undefined}>
              <Icon name={icon} /><span>{label}</span>
              {label === 'My tasks' && <span className="nav-count">4</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="upgrade-card"><div className="upgrade-icon"><Icon name="spark" /></div><strong>Make work flow</strong><p>Bring your team together and move projects forward.</p><button type="button" onClick={() => navigate('Projects')}>Explore projects <Icon name="arrow" /></button></div>
          <div className="user-profile"><div className="avatar avatar--me">JD</div><span><strong>Jordan Davis</strong><small>Product Designer</small></span><button className="icon-button profile-more" aria-label="Profile options" type="button"><Icon name="dots" /></button></div>
        </div>
      </aside>

      {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <div className="main-column">
        <header className="topbar">
          <button type="button" className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{active}</strong></div>
          <div className="topbar-actions">
            <label className="global-search"><Icon name="search" /><input aria-label="Search projects and tasks" placeholder="Search anything..." value={searchValue} onChange={(event) => onSearchChange(event.target.value)} /><kbd>⌘ K</kbd></label>
            <div className="notification-wrap">
              <button className="icon-button notification-button" aria-label="Notifications" aria-expanded={notificationsOpen} type="button" onClick={() => setNotificationsOpen((open) => !open)}><Icon name="bell" /><i /></button>
              {notificationsOpen && <div className="notification-popover"><strong>Notifications</strong><p>You’re all caught up.</p></div>}
            </div>
            <div className="avatar avatar--me topbar-avatar" aria-label="Jordan Davis">JD</div>
          </div>
        </header>
        <main id="main-content" className="page-content">{children}</main>
      </div>
    </div>
  );
}
