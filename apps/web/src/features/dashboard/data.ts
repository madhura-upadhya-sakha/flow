export type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  members: string[];
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  project: string;
  status: string;
  priority: string | null;
  assigneeId: string | null;
  assignee: string | null;
  dueDate: string | null;
};

export type Dashboard = {
  userId: string;
  displayName: string;
  projects: Project[];
  tasks: Task[];
  members: string[];
};

const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api').replace(/\/$/, '');

export async function dashboardRequest<T>(path = '', options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}/dashboard${path}`, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(response.status < 500 && typeof error?.message === 'string'
      ? error.message : 'The dashboard API is unavailable.');
  }
  return response.json();
}

export function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

export const isDone = (task: Task) => ['done', 'completed', 'complete'].includes(task.status.toLowerCase());

export function dateLabel(value: string | null) {
  if (!value) return 'No due date';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}
