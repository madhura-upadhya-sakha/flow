export interface DashboardSummary {
  workspaceId: string;
  generatedAt: string;
  projects: { total: number };
  tasks: { total: number; dueThisWeek: number; overdue: number };
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  ownerId: string | null;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  status: string;
  priority: string | null;
  assigneeId: string | null;
  dueDate: string | null;
}
