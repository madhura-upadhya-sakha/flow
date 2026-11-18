import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../../lib/icons';
import { dashboardRequest, dateLabel, initials, isDone, type Dashboard, type Project, type Task } from './data';

type Props = { search: string };

function AvatarStack({ members }: { members: string[] }) {
  return <div className="avatar-stack" aria-label={`${members.length} project members`}>{members.slice(0, 4).map((person, index) => <span className={`avatar avatar--${['coral', 'violet', 'green', 'blue'][index % 4]}`} key={`${person}-${index}`} title={person}>{person}</span>)}{members.length > 4 && <span className="avatar avatar--extra">+{members.length - 4}</span>}</div>;
}

function ProjectCard({ project, tasks }: { project: Project; tasks: Task[] }) {
  const completed = tasks.filter(isDone).length;
  const progress = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  return (
    <article className="project-card">
      <div className="project-card-top"><div className={`project-icon project-icon--violet`}><Icon name="folder" /></div><button className="icon-button more-button" type="button" aria-label={`More options for ${project.name}`}><Icon name="dots" /></button></div>
      <div className="project-heading"><h3>{project.name}</h3><span className={`status-pill status-pill--${project.status.toLowerCase().replaceAll(' ', '-')}`}><i />{project.status}</span></div>
      <p className="project-description">{project.description}</p>
      <div className="project-progress-label"><span>Progress</span><strong>{progress}%</strong></div>
      <div className="progress-track" role="progressbar" aria-label={`${project.name} progress`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>
      <div className="project-card-footer"><AvatarStack members={project.members.map(initials)} /><span className="task-count">{completed}/{tasks.length} tasks</span><span className="due-date"><Icon name="calendar" />{dateLabel(project.dueDate)}</span></div>
    </article>
  );
}

function TaskRow({ task, pending, onToggle }: { task: Task; pending: boolean; onToggle: (task: Task) => void }) {
  const done = isDone(task);
  const priority = task.priority ?? 'None';
  return (
    <div className={`task-row ${done ? 'task-row--done' : ''}`}>
      <button type="button" className={`task-check ${done ? 'task-check--checked' : ''}`} aria-label={`${done ? 'Mark incomplete' : 'Complete'} ${task.title}`} disabled={pending} aria-pressed={done} onClick={() => onToggle(task)}>{done && <span>✓</span>}</button>
      <div className="task-copy"><strong>{task.title}</strong><span>{task.project}</span></div>
      <span className={`priority priority--${priority.toLowerCase()}`}>{priority}</span>
      <span className="task-due"><Icon name="clock" />{dateLabel(task.dueDate)}</span>
      <span className="avatar avatar--violet task-assignee" title={task.assignee ?? 'Unassigned'}>{task.assignee ? initials(task.assignee) : '—'}</span>
    </div>
  );
}

function NewProjectDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) { setError('Enter a project name.'); return; }
    if (pending) return;
    setError('');
    setPending(true);
    try {
      await onCreate(name.trim(), description.trim());
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not create the project.');
    } finally {
      setPending(false);
    }
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!pending && event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><div className="dialog-heading"><div><span className="eyebrow">WORKSPACE</span><h2 id="new-project-title">Create a project</h2></div><button type="button" className="icon-button" aria-label="Close dialog" disabled={pending} onClick={onClose}><Icon name="close" /></button></div><form onSubmit={submit}><label>Project name<input autoFocus maxLength={200} value={name} onChange={(event) => { setName(event.target.value); setError(''); }} placeholder="e.g. Website redesign" aria-invalid={Boolean(error)} aria-describedby={error ? 'project-name-error' : undefined} /></label>{error && <span className="field-error" id="project-name-error">{error}</span>}<label>Description <span className="optional">Optional</span><textarea rows={3} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this project about?" /></label><div className="dialog-actions"><button type="button" className="button button--secondary" disabled={pending} onClick={onClose}>Cancel</button><button type="submit" disabled={pending} className="button button--primary"><Icon name="plus" />Create project</button></div></form></section></div>;
}

export default function DashboardPage({ search }: Props) {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [error, setError] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [taskFilter, setTaskFilter] = useState<'All tasks' | 'My tasks'>('My tasks');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showProjects, setShowProjects] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    dashboardRequest<Dashboard>('', { signal: controller.signal }).then(setDashboard).catch(() => {
      if (!controller.signal.aborted) setError('Could not load the dashboard.');
    });
    return () => controller.abort();
  }, [loadKey]);

  const retry = () => {
    setError('');
    setLoadKey((key) => key + 1);
  };
  if (!dashboard) return <section className="empty-state">
    {error ? <><p role="alert">{error}</p><button className="button button--secondary" onClick={retry}>Retry</button></>
      : <p role="status">Loading dashboard…</p>}
  </section>;

  const { projects, tasks, members, userId, displayName } = dashboard;
  const query = search.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => `${project.name} ${project.description ?? ''}`.toLowerCase().includes(query));
  const visibleTasks = tasks.filter((task) => `${task.title} ${task.project}`.toLowerCase().includes(query) &&
    (taskFilter === 'All tasks' || task.assigneeId === userId));
  const toggleTask = async (task: Task) => {
    setSaving(true);
    setError('');
    const done = !isDone(task);
    try {
      await dashboardRequest(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
      setDashboard((current) => current && {
        ...current,
        tasks: current.tasks.map((item) => item.id === task.id ? { ...item, status: done ? 'Done' : 'To do' } : item),
      });
    } catch {
      setError('Could not update the task.');
    } finally {
      setSaving(false);
    }
  };
  const createProject = async (name: string, description: string) => {
    setError('');
    const project = await dashboardRequest<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
    setDashboard((current) => current && { ...current, projects: [project, ...current.projects] });
    setDialogOpen(false);
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + (7 - (today.getDay() || 7)));
  const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const openTasks = tasks.filter((task) => !isDone(task));
  const dueThisWeek = openTasks.filter((task) => task.dueDate && task.dueDate >= dateKey(today) && task.dueDate <= dateKey(endOfWeek)).length;
  const overdue = openTasks.filter((task) => task.dueDate && task.dueDate < dateKey(today)).length;
  const todayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();

  return (
    <div className="dashboard-page">
      <div className="welcome-row"><div><div className="date-kicker">{todayLabel}</div><h1>Welcome, {displayName} <span className="wave">✦</span></h1><p>Here’s what’s happening with your projects today.</p></div><button type="button" className="button button--primary new-project-button" disabled={saving} onClick={() => setDialogOpen(true)}><Icon name="plus" />New project</button></div>

      {error && <p role="alert">{error} <button className="text-button" onClick={retry}>Refresh dashboard</button></p>}
      <section className="stats-grid" aria-label="Workspace summary">
        <article className="stat-card"><div className="stat-top"><span>Projects</span><span className="stat-icon stat-icon--purple"><Icon name="folder" /></span></div><div className="stat-value">{projects.length}</div></article>
        <article className="stat-card"><div className="stat-top"><span>Tasks completed</span><span className="stat-icon stat-icon--green"><Icon name="check" /></span></div><div className="stat-value">{tasks.length - openTasks.length}<span className="stat-denominator">/ {tasks.length}</span></div></article>
        <article className="stat-card"><div className="stat-top"><span>Due this week</span><span className="stat-icon stat-icon--orange"><Icon name="calendar" /></span></div><div className="stat-value">{dueThisWeek}</div><div className="stat-foot"><span className="trend trend--warning">{overdue} overdue</span></div></article>
        <article className="stat-card"><div className="stat-top"><span>Team members</span><span className="stat-icon stat-icon--blue"><Icon name="users" /></span></div><div className="stat-value">{members.length}</div><div className="mini-avatars"><AvatarStack members={members.map(initials)} /></div></article>
      </section>

      <section className="section-block projects-block">
        <div className="section-heading"><div><div className="section-title-line"><h2>Projects</h2><span className="section-count">{visibleProjects.length}</span></div><p>Keep your work moving forward</p></div>{visibleProjects.length > 3 && <button className="text-button" type="button" onClick={() => setShowProjects(!showProjects)}>{showProjects ? 'Show fewer projects' : 'View all projects'} <Icon name="arrow" /></button>}</div>
        {visibleProjects.length ? <div className="projects-grid">{(showProjects ? visibleProjects : visibleProjects.slice(0, 3)).map((project) => <ProjectCard key={project.id} project={project} tasks={tasks.filter((task) => task.projectId === project.id)} />)}</div> : <div className="empty-state"><span className="empty-icon"><Icon name="search" /></span><strong>No projects found</strong><p>{query ? 'Try a different search term.' : 'Create a project to get started.'}</p></div>}
      </section>

      <div>
        <section className="panel tasks-panel">
          <div className="panel-heading"><div><div className="section-title-line"><h2>My tasks</h2><span className="section-count section-count--soft">{visibleTasks.filter((task) => !isDone(task)).length}</span></div><p>Your focus for today</p></div><label className="select-wrap"><span className="sr-only">Task filter</span><select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value as 'All tasks' | 'My tasks')}><option>My tasks</option><option>All tasks</option></select><Icon name="chevron" /></label></div>
          <div className="task-list">{visibleTasks.length ? visibleTasks.map((task) => <TaskRow key={task.id} task={task} pending={saving} onToggle={toggleTask} />) : <div className="empty-state empty-state--compact"><strong>No tasks match</strong><p>Try clearing your search or changing the filter.</p></div>}</div>
          {taskFilter === 'My tasks' && <button type="button" className="panel-footer-button" onClick={() => setTaskFilter('All tasks')}>View all tasks <Icon name="arrow" /></button>}
        </section>

      </div>
      {dialogOpen && <NewProjectDialog onClose={() => setDialogOpen(false)} onCreate={createProject} />}
    </div>
  );
}
