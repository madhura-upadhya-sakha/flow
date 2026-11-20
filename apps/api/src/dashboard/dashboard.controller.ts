import { createHash } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Query,
  Header, Patch, Post, Req, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DashboardUploadGuard } from './dashboard-upload.guard';
import { WorkspaceIdentityService } from '../auth/workspace-identity.service';
import { localWorkspaceIdentity } from '../auth/local-workspace';
import { Public } from '../common/decorators/public.decorator';
import { DatabaseService } from '../database/database.service';

import { TaskImportService } from './task-import.service';
import { maxTaskAttachmentBytes, TaskDetailsService, type TaskUpload } from './task-details.service';
import { WorkspaceAdministrationService } from './workspace-administration.service';
import { WorkspaceUsersService } from './workspace-users.service';
import { hasWorkspaceAdminRole } from './workspace-roles';
import { TaskBoardService } from './task-board.service';
import { dueDate, optionalText, requiredText, rethrowTaskScheduleError, uuid, wholeMinutes } from './workspace-input';

type Input = Record<string, unknown>;

@Public()
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly board: TaskBoardService,
    private readonly taskDetails: TaskDetailsService,
    private readonly imports: TaskImportService,
    private readonly admin: WorkspaceAdministrationService,
    private readonly users: WorkspaceUsersService,
    private readonly identity: WorkspaceIdentityService,
  ) {}

  private async workspace(request: Request, action?: 'edit' | 'assign') {
    request.res?.setHeader('Cache-Control', 'no-store');
    const local = !request.headers.authorization && localWorkspaceIdentity(this.config, request);
    const identity = local || await this.identity.resolve(request);
    const { workspaceId, userId } = identity;
    const { rows } = await this.db.pool.query<{ displayName: string; workspaceName: string; role: string; status: string; timezone: string }>(
      `SELECT m.name AS "displayName", w.name AS "workspaceName", m.role, m.status, COALESCE((SELECT name FROM pg_timezone_names WHERE name = w.timezone), 'UTC') AS timezone FROM workspace_people m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, userId],
    );
    if (!rows[0]) throw new NotFoundException('Workspace membership is missing.');
    const { status, ...member } = rows[0];
    if (status !== 'active') throw new ForbiddenException('An active workspace membership is required.');
    const canViewAdministration = hasWorkspaceAdminRole(member.role);
    if (!local && !['GET', 'HEAD'].includes(request.method) && !canViewAdministration) {
      const allowed = action && await this.admin.canEditProjectsAndTasks(workspaceId, member.role, action === 'assign');
      if (!allowed) throw new ForbiddenException('Your workspace role does not allow this change.');
    }
    return { workspaceId, userId, ...member, canViewAdministration };
  }

  @Get()
  async getDashboard(@Req() request: Request) {
    const workspace = await this.workspace(request);
    const result = await this.db.pool.query(
      `SELECT
        (SELECT jsonb_build_object('name', s.name, 'daysRemaining', s.ends_on - today.local_date)
         FROM workspace_sprints s CROSS JOIN LATERAL (
           SELECT (CURRENT_TIMESTAMP AT TIME ZONE $2)::date AS local_date
         ) today
         WHERE s.workspace_id = $1 AND today.local_date BETWEEN s.starts_on AND s.ends_on
         ORDER BY s.starts_on DESC, s.name LIMIT 1) AS "activeSprint",
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC, p.id) FROM (
          SELECT p.id, p.name, p.description, p.status, p.start_date AS "startDate", p.due_date AS "dueDate", p.created_at, owner.name AS owner,
            ARRAY(SELECT u.name FROM project_members m JOIN workspace_people u ON (u.workspace_id, u.user_id) = (m.workspace_id, m.user_id)
                  WHERE m.project_id = p.id AND m.workspace_id = p.workspace_id ORDER BY u.name, u.user_id) AS members
          FROM projects p LEFT JOIN workspace_people owner ON (owner.workspace_id, owner.user_id) = (p.workspace_id, p.owner_id) WHERE p.workspace_id = $1
        ) p), '[]') AS projects,
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."dueDate" NULLS LAST, t.id) FROM (
          SELECT t.id, t.project_id AS "projectId", t.title, t.description, p.name AS project, t.status, t.priority,
            t.assignee_id AS "assigneeId", m.name AS assignee, t.due_date AS "dueDate",
            t.start_date AS "startDate", t.created_at AS "createdAt", t.updated_at AS "updatedAt",
            t.board_position AS "boardPosition", t.estimate_minutes AS "estimateMinutes"
          FROM tasks t JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
          LEFT JOIN workspace_people m ON m.workspace_id = t.workspace_id AND m.user_id = t.assignee_id
          WHERE t.workspace_id = $1
        ) t), '[]') AS tasks,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name, 'role', m.role)
                  ORDER BY m.name, m.user_id)
                  FROM workspace_people m WHERE m.workspace_id = $1), '[]') AS members`,
      [workspace.workspaceId, workspace.timezone],
    );
    return { ...workspace, ...result.rows[0] };
  }

  private async administrator(request: Request) {
    const workspace = await this.workspace(request);
    if (!workspace.canViewAdministration) throw new ForbiddenException('Workspace administrator access is required.');
    return workspace;
  }

  @Get('administration/users')
  async userDirectory(@Req() request: Request, @Query() query: Input) {
    return this.users.directory(await this.administrator(request), query);
  }

  @Get('administration/users/options')
  async userOptions(@Req() request: Request) {
    return this.users.options(await this.administrator(request));
  }

  @Get('administration/users/:id')
  async userProfile(@Req() request: Request, @Param('id') id: string) {
    const workspace = await this.workspace(request);
    const memberId = uuid(id);
    if (memberId !== workspace.userId && !workspace.canViewAdministration) {
      throw new ForbiddenException('Workspace administrator access is required.');
    }
    return this.users.detail(workspace, memberId);
  }

  @Post('administration/users')
  async addUser(@Req() request: Request, @Body() body?: Input) {
    return this.users.create(await this.administrator(request), body);
  }

  @Patch('administration/users/:id')
  async editUser(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    return this.users.update(await this.administrator(request), uuid(id), body);
  }

  @Get('administration/:section')
  async administration(@Req() request: Request, @Param('section') section: string, @Query() query: Input) {
    const workspace = await this.administrator(request);
    switch (section) {
      case 'organization': return this.admin.organization(workspace);
      case 'departments': return this.admin.departments(workspace);
      case 'roles': return this.admin.roles(workspace);
      case 'audit': return this.admin.audit(workspace, query);
      default: throw new NotFoundException('Administration section not found.');
    }
  }

  @Get('administration/audit/:id')
  async auditDetails(@Req() request: Request, @Param('id') id: string) {
    return this.admin.auditDetails(await this.administrator(request), uuid(id));
  }

  @Post('administration/departments')
  async createDepartment(@Req() request: Request, @Body() body?: Input) {
    return this.admin.saveDepartment(await this.administrator(request), body);
  }

  @Patch('administration/departments/:id')
  async updateDepartment(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    return this.admin.saveDepartment(await this.administrator(request), body, uuid(id));
  }

  @Patch('administration/reporting/:id')
  async updateReporting(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    return this.admin.updateReporting(await this.administrator(request), uuid(id), body);
  }

  @Post('administration/roles')
  async createRole(@Req() request: Request, @Body() body?: Input) {
    return this.admin.createRole(await this.administrator(request), body);
  }

  @Patch('administration/roles/:key')
  async updatePermission(@Req() request: Request, @Param('key') key: string, @Body() body?: Input) {
    return this.admin.updatePermission(await this.administrator(request), key, body);
  }

  @Get('workspace-panels')
  async workspacePanels(@Req() request: Request) {
    const { workspaceId, timezone } = await this.workspace(request);
    const { rows: [panels] } = await this.db.pool.query(
      `WITH week AS (
         SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE $2)::date AS monday
       ), recent AS (
         SELECT a.id, a.task_id AS "taskId", t.title AS task, u.display_name AS actor, a.action,
                a.changed_fields AS fields, a.status_after AS "statusAfter", a.created_at AS "createdAt"
         FROM task_activity a
         JOIN tasks t ON (t.id, t.workspace_id) = (a.task_id, a.workspace_id)
         LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.workspace_id = $1
         ORDER BY a.created_at DESC, a.id DESC LIMIT 5
       )
       SELECT COALESCE((SELECT jsonb_agg(recent ORDER BY "createdAt" DESC, id DESC) FROM recent), '[]') AS activity,
         (SELECT COALESCE(sum(weekly_capacity_minutes), 0)::int FROM workspace_members WHERE workspace_id = $1) AS "capacityMinutes",
         (SELECT COALESCE(sum(t.estimate_minutes), 0)::int
          FROM tasks t
          JOIN workspace_members m ON (m.workspace_id, m.user_id) = (t.workspace_id, t.assignee_id)
          CROSS JOIN week
          WHERE t.workspace_id = $1 AND t.due_date >= monday AND t.due_date < monday + 7) AS "assignedMinutes"`,
      [workspaceId, timezone],
    );
    return panels;
  }

  @Get('unread-notifications')
  async unreadNotifications(@Req() request: Request) {
    const { workspaceId, userId } = await this.workspace(request);
    const { rows: [total] } = await this.db.pool.query(
      'SELECT count(*)::int AS count FROM notifications WHERE workspace_id = $1 AND recipient_user_id = $2 AND read_at IS NULL',
      [workspaceId, userId],
    );
    return total;
  }

  @Get('overview')
  async overview(@Req() request: Request) {
    const { workspaceId, userId, timezone } = await this.workspace(request);
    const { rows: [overview] } = await this.db.pool.query(
      `WITH bounds AS (
         SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE $3)::date AS monday
       ), completions AS (
         SELECT (completed_at AT TIME ZONE $3)::date AS day, count(*)::int AS count
         FROM task_completions CROSS JOIN bounds
         WHERE workspace_id = $1
           AND completed_at >= ((monday - 7)::timestamp AT TIME ZONE $3)
           AND completed_at < ((monday + 7)::timestamp AT TIME ZONE $3)
         GROUP BY day
       ), time_totals AS (
         SELECT COALESCE(sum(minutes), 0)::int AS minutes,
           COALESCE(sum(minutes) FILTER (WHERE user_id = $2), 0)::int AS personal
         FROM task_time_entries CROSS JOIN bounds
         WHERE workspace_id = $1 AND logged_at >= (monday::timestamp AT TIME ZONE $3)
           AND logged_at < ((monday + 7)::timestamp AT TIME ZONE $3)
       )
       SELECT (SELECT jsonb_agg(jsonb_build_object('date', monday + day_index, 'count', COALESCE(c.count, 0)) ORDER BY day_index)
         FROM generate_series(0, 6) AS days(day_index) LEFT JOIN completions c ON c.day = monday + day_index)
         AS "days",
         (SELECT COALESCE(sum(count), 0)::int FROM completions WHERE day < monday) AS "previousCompletions",
         time_totals.minutes AS "workspaceMinutes", time_totals.personal AS "personalMinutes"
       FROM bounds CROSS JOIN time_totals`,
      [workspaceId, userId, timezone],
    );
    return overview;
  }

  @Post('tasks/:id/time-entries')
  async logTaskTime(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    const { workspaceId, userId } = await this.workspace(request, 'edit');
    const minutes = body?.minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new BadRequestException('Enter whole minutes between 1 and 1440.');
    }
    const { rows: [entry] } = await this.db.pool.query<{ id: string; minutes: number }>(
      `INSERT INTO task_time_entries (workspace_id, task_id, user_id, request_id, minutes)
       SELECT t.workspace_id, t.id, $3, $4, $5 FROM tasks t WHERE t.workspace_id = $1 AND t.id = $2
       ON CONFLICT (task_id, user_id, request_id) DO UPDATE SET request_id = EXCLUDED.request_id
       RETURNING id, minutes`,
      [workspaceId, uuid(id), userId, uuid(body?.requestId), minutes],
    );
    if (!entry) throw new NotFoundException('Task not found.');
    if (entry.minutes !== minutes) throw new ConflictException('This request already logged a different duration.');
    return entry;
  }

  @Get('board-cards')
  async getBoardCards(@Req() request: Request, @Query('projectId') projectId?: string) {
    const { workspaceId } = await this.workspace(request);
    const scope = projectId === undefined ? null : uuid(projectId);
    const { rows: [result] } = await this.db.pool.query<{ cards: unknown[]; visibleProject: boolean }>(
      `WITH cards AS (
         SELECT t.id,
           COALESCE((SELECT jsonb_agg(l.name ORDER BY l.name) FROM task_labels tl
             JOIN labels l ON (l.workspace_id, l.id) = (tl.workspace_id, tl.label_id)
             WHERE tl.workspace_id = t.workspace_id AND tl.task_id = t.id), '[]') AS labels,
           (SELECT count(*)::int FROM task_comments c WHERE c.workspace_id = t.workspace_id AND c.task_id = t.id) AS "commentCount",
           (SELECT count(*)::int FROM tasks s WHERE s.workspace_id = t.workspace_id AND s.parent_task_id = t.id) AS "subtaskCount",
           (SELECT count(*)::int FROM tasks s WHERE s.workspace_id = t.workspace_id AND s.parent_task_id = t.id
             AND lower(s.status) IN ('done', 'complete', 'completed')) AS "completedSubtasks"
         FROM tasks t WHERE t.workspace_id = $1 AND ($2::uuid IS NULL OR t.project_id = $2)
       )
       SELECT COALESCE((SELECT jsonb_agg(cards) FROM cards), '[]') AS cards,
         ($2 IS NULL OR EXISTS (SELECT 1 FROM projects WHERE workspace_id = $1 AND id = $2)) AS "visibleProject"`,
      [workspaceId, scope],
    );
    if (!result.visibleProject) throw new NotFoundException('Project not found.');
    return result.cards;
  }

  @Get('projects/:id/overview')
  async getProjectOverview(@Req() request: Request, @Param('id') id: string) {
    const { workspaceId } = await this.workspace(request);
    const { rows: [overview] } = await this.db.pool.query(
      `WITH project_tasks AS (
         SELECT id, assignee_id, status, estimate_minutes FROM tasks WHERE workspace_id = $1 AND project_id = $2
       ), assignments AS (
         SELECT assignee_id,
           count(*) FILTER (WHERE lower(status) NOT IN ('done', 'complete', 'completed'))::int AS active,
           COALESCE(sum(estimate_minutes) FILTER (WHERE lower(status) NOT IN ('done', 'complete', 'completed')), 0)::int AS minutes
         FROM project_tasks WHERE assignee_id IS NOT NULL GROUP BY assignee_id
       ), participant_ids AS (
         SELECT user_id FROM project_members WHERE workspace_id = $1 AND project_id = $2
         UNION SELECT assignee_id FROM assignments
       ), participants AS (
         SELECT u.id, u.display_name AS name, m.weekly_capacity_minutes AS "capacityMinutes",
                COALESCE(a.active, 0) AS "activeTasks", COALESCE(a.minutes, 0) AS "assignedMinutes"
         FROM participant_ids p JOIN workspace_members m ON m.workspace_id = $1 AND m.user_id = p.user_id
         JOIN users u ON u.id = m.user_id LEFT JOIN assignments a ON a.assignee_id = u.id
       ), recent AS (
         SELECT a.id, a.task_id AS "taskId", t.title AS task, u.display_name AS actor, a.action, a.changed_fields AS fields,
                a.status_after AS "statusAfter", a.created_at AS "createdAt"
         FROM task_activity a JOIN tasks t ON (t.id, t.workspace_id) = (a.task_id, a.workspace_id)
         LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.workspace_id = $1 AND t.project_id = $2
         ORDER BY a.created_at DESC, a.id DESC LIMIT 6
       )
       SELECT p.id, p.name, p.start_date AS "startDate", p.due_date AS "dueDate", owner.name AS owner,
          (SELECT COALESCE(sum(e.minutes), 0)::int FROM task_time_entries e
            JOIN project_tasks t ON t.id = e.task_id WHERE e.workspace_id = $1) AS "loggedMinutes",
          COALESCE((SELECT jsonb_agg(participants ORDER BY name, id) FROM participants), '[]') AS contributors,
          COALESCE((SELECT jsonb_agg(recent ORDER BY "createdAt" DESC, id DESC) FROM recent), '[]') AS activity
       FROM projects p LEFT JOIN workspace_people owner ON (owner.workspace_id, owner.user_id) = (p.workspace_id, p.owner_id)
       WHERE p.workspace_id = $1 AND p.id = $2`,
      [workspaceId, uuid(id)],
    );
    if (!overview) throw new NotFoundException('Project not found.');
    return overview;
  }

  @Post('projects')
  async createProject(@Req() request: Request, @Body() body?: Input) {
    const { workspaceId, userId } = await this.workspace(request);
    const name = requiredText(body?.name, 'a project name', 200);
    const description = optionalText(body?.description, 'a description', 5000);
    const status = requiredText(body?.status ?? 'On track', 'a project status', 64);
    const date = dueDate(body?.dueDate);
    const startDate = dueDate(body?.startDate);
    if (startDate && date && startDate > date) throw new BadRequestException('The start date must be on or before the due date.');
    const { rows } = await this.db.pool.query(
      `WITH project AS (
        INSERT INTO projects (workspace_id, name, description, status, due_date, start_date, owner_id, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $7, $6, $6, $6)
        RETURNING id, name, description, status, due_date, start_date
      ), membership AS (
        INSERT INTO project_members (project_id, workspace_id, user_id, created_by, updated_by)
        SELECT id, $1, $6, $6, $6 FROM project RETURNING user_id, project_id
      )
      SELECT p.id, p.name, p.description, p.status, p.start_date::text AS "startDate", p.due_date::text AS "dueDate",
        ARRAY[u.display_name] AS members, u.display_name AS owner
      FROM project p JOIN membership m ON m.project_id = p.id JOIN users u ON u.id = m.user_id`,
      [workspaceId, name, description, status, date, userId, startDate],
    );
    return rows[0];
  }

  @Patch('projects/:id')
  async updateProject(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    uuid(id);
    const { workspaceId, userId } = await this.workspace(request, 'edit');
    const date = dueDate(body?.dueDate);
    const startDate = dueDate(body?.startDate);
    if (startDate && date && startDate > date) throw new BadRequestException('The start date must be on or before the due date.');
    const { rows } = await this.db.pool.query(
      `UPDATE projects p SET name = $3, description = $4, status = $5, due_date = $6,
         start_date = CASE WHEN $9::boolean THEN $8::date ELSE p.start_date END,
         updated_at = CURRENT_TIMESTAMP, updated_by = $7
       WHERE p.id = $1 AND p.workspace_id = $2
       RETURNING p.id, p.name, p.description, p.status, p.start_date::text AS "startDate", p.due_date::text AS "dueDate",
         (SELECT u.name FROM workspace_people u WHERE (u.workspace_id, u.user_id) = (p.workspace_id, p.owner_id)) AS owner,
         ARRAY(SELECT u.name FROM project_members m JOIN workspace_people u ON (u.workspace_id, u.user_id) = (m.workspace_id, m.user_id)
               WHERE m.project_id = p.id AND m.workspace_id = p.workspace_id ORDER BY u.name, u.user_id) AS members`,
      [id, workspaceId, requiredText(body?.name, 'a project name', 200),
        optionalText(body?.description, 'a description', 5000), requiredText(body?.status, 'a project status', 64),
        date, userId, startDate, body?.startDate !== undefined],
    ).catch((error: { code?: string; constraint?: string }) => {
      if (error.code === '23514' && error.constraint === 'ck_projects_date_range') {
        throw new BadRequestException('The start date must be on or before the due date.');
      }
      throw error;
    });
    if (!rows[0]) throw new NotFoundException('Project not found.');
    return rows[0];
  }

  @Post('tasks')
  createTask(@Req() request: Request, @Body() body?: Input) {
    return this.saveTask(request, body);
  }

  @Patch('tasks/:id')
  async updateTask(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    uuid(id);
    if (body?.done === undefined) return this.saveTask(request, body, id);
    const { workspaceId, userId } = await this.workspace(request, 'edit');
    if (typeof body.done !== 'boolean') throw new BadRequestException('Provide a boolean completion state.');
    const { rows } = await this.db.pool.query(
      `UPDATE tasks SET status = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
       WHERE workspace_id = $3 AND id = $4 RETURNING status, updated_at AS "updatedAt"`,
      [body.done ? 'Done' : 'To do', userId, workspaceId, id],
    );
    if (!rows[0]) throw new NotFoundException('Task not found.');
    return rows[0];
  }

  private async saveTask(request: Request, body?: Input, id?: string) {
    const { workspaceId, userId } = await this.workspace(request, id ? 'assign' : undefined);
    const projectId = uuid(body?.projectId);
    const assigneeId = body?.assigneeId ? uuid(body.assigneeId) : null;
    const title = requiredText(body?.title, 'a task title', 240);
    const description = optionalText(body?.description, 'a description', 5000);
    const status = requiredText(body?.status, 'a task status', 64);
    const priority = optionalText(body?.priority, 'a priority', 64);
    const date = dueDate(body?.dueDate);
    const startDate = dueDate(body?.startDate, 'start date');
    if (startDate && date && startDate > date) throw new BadRequestException('The start date must be on or before the due date.');
    const estimate = body?.estimateMinutes;
    const estimateMinutes = estimate === null || estimate === '' || estimate === undefined
      ? null : wholeMinutes(estimate, 'the estimate');
    const requestId = !id && body?.requestId !== undefined ? uuid(body.requestId) : null;
    const createRequestHash = requestId ? createHash('sha256')
      .update(JSON.stringify([projectId, title, status, priority, assigneeId, date, description, estimateMinutes, ...(startDate ? [startDate] : [])]))
      .digest('hex') : null;
    const changes = id
      ? `UPDATE tasks SET project_id = $2, title = $3, status = $4, priority = $5, assignee_id = $6,
           due_date = $7, updated_by = $8, description = $9,
           estimate_minutes = CASE WHEN $13::boolean THEN $10::integer ELSE estimate_minutes END,
           start_date = CASE WHEN $14::boolean THEN $11::date ELSE start_date END, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND id = $12 AND EXISTS (SELECT 1 FROM target)
         RETURNING *`
      : `INSERT INTO tasks (workspace_id, project_id, title, status, priority, assignee_id, due_date, created_by, updated_by, description, estimate_minutes,
           start_date, create_request_id, create_request_hash)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13 FROM target
         ON CONFLICT (workspace_id, created_by, create_request_id) DO UPDATE SET create_request_id = EXCLUDED.create_request_id
         RETURNING *`;
    const { rows } = await this.db.pool.query(
      `WITH target AS (
         SELECT 1 FROM projects p WHERE p.workspace_id = $1 AND p.id = $2
           AND ($6::uuid IS NULL OR EXISTS (
             SELECT 1 FROM workspace_members m WHERE m.workspace_id = $1 AND m.user_id = $6
           ))
       ), changed AS (${changes})
       SELECT t.id, t.project_id AS "projectId", t.title, t.description, p.name AS project, t.status, t.priority,
         t.assignee_id AS "assigneeId", u.name AS assignee, t.due_date::text AS "dueDate",
         t.start_date::text AS "startDate", t.created_at AS "createdAt", t.updated_at AS "updatedAt",
         t.board_position AS "boardPosition", t.estimate_minutes AS "estimateMinutes",
         t.create_request_hash AS "requestHash"
       FROM changed t
       JOIN projects p ON (p.workspace_id, p.id) = (t.workspace_id, t.project_id)
       LEFT JOIN workspace_people u ON (u.workspace_id, u.user_id) = (t.workspace_id, t.assignee_id)`,
      [workspaceId, projectId, title, status, priority, assigneeId, date, userId, description, estimateMinutes, startDate,
        ...(id ? [id, estimate !== undefined, body?.startDate !== undefined] : [requestId, createRequestHash])],
    ).catch(rethrowTaskScheduleError);
    if (!rows[0]) throw new NotFoundException('Task, project, or assignee not found in this workspace.');
    const { requestHash, ...task } = rows[0];
    if (requestId && createRequestHash !== requestHash) throw new ConflictException('This task creation request was already used for different details.');
    return task;
  }

  @Get('tasks/:id/details')
  async getTaskDetails(@Req() request: Request, @Param('id') id: string) {
    const { workspaceId } = await this.workspace(request);
    return this.taskDetails.details(workspaceId, uuid(id));
  }

  @Patch('tasks/:id/details')
  async patchTaskDetails(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    const { workspaceId, userId } = await this.workspace(request, Object.hasOwn(body ?? {}, 'assigneeId') ? 'assign' : 'edit');
    return this.taskDetails.update(workspaceId, userId, uuid(id), body);
  }

  @Post('tasks/:id/subtasks')
  async createSubtask(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    const { workspaceId, userId } = await this.workspace(request);
    return this.taskDetails.createSubtask(workspaceId, userId, uuid(id), body);
  }

  @Post('tasks/:id/attachments')
  @UseGuards(DashboardUploadGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: maxTaskAttachmentBytes, files: 1, fields: 0 } }))
  async attachTaskFile(@Req() request: Request, @Param('id') id: string, @UploadedFile() file?: TaskUpload) {
    const { workspaceId, userId } = await this.workspace(request, 'edit');
    return this.taskDetails.attachFile(workspaceId, userId, uuid(id), file);
  }

  @Get('tasks/:id/attachments/:fileId')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadTaskFile(@Req() request: Request, @Param('id') id: string, @Param('fileId') fileId: string) {
    const { workspaceId } = await this.workspace(request);
    const file = await this.taskDetails.attachmentFile(workspaceId, uuid(id), uuid(fileId));
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    return new StreamableFile(file.content, { type: 'application/octet-stream', disposition: `attachment; filename="attachment"; filename*=UTF-8''${name}` });
  }

  @Post('tasks/:id/attachment-links')
  async attachTaskLink(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    const { workspaceId } = await this.workspace(request, 'edit');
    return this.taskDetails.attachLink(workspaceId, uuid(id), body);
  }

  @Patch('tasks/:id/board-position')
  async moveTask(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    const { workspaceId, userId } = await this.workspace(request, 'edit');
    return this.board.move(workspaceId, userId, uuid(id), body);
  }

  @Get('tasks/:id/activity')
  async getTaskActivity(@Req() request: Request, @Param('id') id: string, @Query('cursor') cursor?: string) {
    const { workspaceId } = await this.workspace(request);
    const { rows } = await this.db.pool.query<{ items: { id: string }[]; validCursor: boolean }>(
      `WITH anchor AS (
         SELECT created_at, id FROM task_activity WHERE workspace_id = $1 AND task_id = $2 AND id = $3
       ), page AS (
         SELECT a.id, a.action, a.changed_fields AS fields, u.display_name AS actor, a.created_at AS "createdAt"
         FROM task_activity a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.workspace_id = $1 AND a.task_id = $2
           AND ($3::uuid IS NULL OR (a.created_at, a.id) < (SELECT created_at, id FROM anchor))
         ORDER BY a.created_at DESC, a.id DESC LIMIT 26
       )
       SELECT COALESCE((SELECT jsonb_agg(page ORDER BY "createdAt" DESC, id DESC) FROM page), '[]') AS items,
              ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM anchor)) AS "validCursor"
       FROM tasks WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, uuid(id), cursor === undefined ? null : uuid(cursor)],
    );
    const [page] = rows;
    if (!page || !page.validCursor) throw new NotFoundException('Task or activity cursor not found.');
    const items = page.items.slice(0, 25);
    return { items, nextCursor: page.items.length > 25 ? items[24].id : null };
  }

  @Get('tasks/:id/comments')
  async getTaskComments(@Req() request: Request, @Param('id') id: string, @Query('cursor') cursor?: string) {
    const { workspaceId } = await this.workspace(request);
    const { rows } = await this.db.pool.query<{ items: { id: string }[]; validCursor: boolean }>(
      `WITH anchor AS (
         SELECT created_at, id FROM task_comments WHERE workspace_id = $1 AND task_id = $2 AND id = $3
       ), page AS (
         SELECT c.id, u.display_name AS author, c.body, c.created_at AS "createdAt"
         FROM task_comments c JOIN users u ON u.id = c.author_id
         WHERE c.workspace_id = $1 AND c.task_id = $2
           AND ($3::uuid IS NULL OR (c.created_at, c.id) < (SELECT created_at, id FROM anchor))
         ORDER BY c.created_at DESC, c.id DESC LIMIT 26
       )
       SELECT COALESCE((SELECT jsonb_agg(page ORDER BY "createdAt" DESC, id DESC) FROM page), '[]') AS items,
              ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM anchor)) AS "validCursor"
       FROM tasks WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, uuid(id), cursor === undefined ? null : uuid(cursor)],
    );
    const [page] = rows;
    if (!page || !page.validCursor) throw new NotFoundException('Task or comment cursor not found.');
    const items = page.items.slice(0, 25);
    return { items, nextCursor: page.items.length > 25 ? items[24].id : null };
  }

  @Post('tasks/:id/comments')
  async addTaskComment(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    const { workspaceId, userId } = await this.workspace(request, 'edit');
    const text = requiredText(body?.body, 'a comment', 5000);
    const { rows } = await this.db.pool.query<{ body: string }>(
      `WITH saved AS (
         INSERT INTO task_comments(workspace_id, task_id, author_id, request_id, body)
         SELECT workspace_id, id, $3, $4, $5 FROM tasks WHERE workspace_id = $1 AND id = $2
         ON CONFLICT (task_id, author_id, request_id) DO UPDATE SET request_id = EXCLUDED.request_id
         RETURNING id, author_id, body, created_at
       )
       SELECT c.id, u.display_name AS author, c.body, c.created_at AS "createdAt"
       FROM saved c JOIN users u ON u.id = c.author_id`,
      [workspaceId, uuid(id), userId, uuid(body?.requestId), text],
    );
    if (!rows[0]) throw new NotFoundException('Task not found.');
    if (rows[0].body !== text) throw new ConflictException('This comment request was already used for different text.');
    return rows[0];
  }

  @Delete('tasks/:id')
  async deleteTask(@Req() request: Request, @Param('id') id: string) {
    uuid(id);
    const { workspaceId } = await this.workspace(request);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT id FROM tasks WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, id]);
      if (!locked.rowCount) throw new NotFoundException('Task not found.');
      await client.query('DELETE FROM task_labels WHERE workspace_id = $1 AND task_id = $2', [workspaceId, id]);
      await client.query('DELETE FROM tasks WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
      await client.query('COMMIT');
      return { id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Delete('projects/:id')
  async deleteProject(@Req() request: Request, @Param('id') id: string) {
    uuid(id);
    const { workspaceId } = await this.workspace(request);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT id FROM projects WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, id]);
      if (!locked.rowCount) throw new NotFoundException('Project not found.');
      const tasks = await client.query('SELECT 1 FROM tasks WHERE workspace_id = $1 AND project_id = $2 LIMIT 1', [workspaceId, id]);
      if (tasks.rowCount) throw new ConflictException('Move or delete the project’s tasks first.');
      await client.query('DELETE FROM project_members WHERE workspace_id = $1 AND project_id = $2', [workspaceId, id]);
      await client.query('DELETE FROM projects WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
      await client.query('COMMIT');
      return { id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('imports/preview')
  async previewImport(@Req() request: Request, @Body() body?: Input) {
    const { workspaceId } = await this.workspace(request);
    return this.imports.preview(workspaceId, body);
  }

  @Post('imports')
  async submitImport(@Req() request: Request, @Body() body?: Input) {
    const { workspaceId, userId } = await this.workspace(request);
    return this.imports.submit(workspaceId, userId, body);
  }

  @Get('imports')
  async importHistory(@Req() request: Request, @Query('cursor') cursor?: string) {
    const { workspaceId } = await this.workspace(request);
    return this.imports.history(workspaceId, cursor);
  }

  @Get('imports/:id/report')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="import-errors.csv"')
  async importReport(@Req() request: Request, @Param('id') id: string) {
    const { workspaceId } = await this.workspace(request);
    return this.imports.report(workspaceId, uuid(id));
  }

  @Get('team-workload')
  async getTeamWorkload(@Req() request: Request, @Query('projectId') projectId?: string) {
    const { workspaceId, timezone } = await this.workspace(request);
    const filter = projectId === undefined ? null : uuid(projectId);
    if (filter && !(await this.db.pool.query('SELECT id FROM projects WHERE workspace_id = $1 AND id = $2', [workspaceId, filter])).rowCount) {
      throw new NotFoundException('Project not found.');
    }
    const { rows } = await this.db.pool.query(
      `WITH week AS (
         SELECT (CURRENT_TIMESTAMP AT TIME ZONE $3)::date AS today,
           date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE $3)::date AS monday
       ), sprint AS (
         SELECT s.starts_on, s.ends_on FROM workspace_sprints s, week
         WHERE s.workspace_id = $1 AND week.today BETWEEN s.starts_on AND s.ends_on
         ORDER BY s.starts_on DESC, s.name LIMIT 1
       ), task_counts AS (
         SELECT t.assignee_id,
           count(*) FILTER (WHERE lower(t.status) NOT IN ('done', 'completed', 'complete'))::int AS open,
           count(*) FILTER (WHERE lower(t.status) IN ('done', 'completed', 'complete'))::int AS completed,
           count(*) FILTER (WHERE lower(t.status) = 'in review')::int AS review,
           count(*) FILTER (WHERE lower(t.status) NOT IN ('done', 'completed', 'complete')
             AND t.due_date < week.today)::int AS overdue,
           COALESCE(sum(t.estimate_minutes) FILTER (WHERE t.due_date >= week.monday AND t.due_date < week.monday + 7), 0)::int AS assigned
         FROM tasks t CROSS JOIN week
         WHERE t.workspace_id = $1 AND t.assignee_id IS NOT NULL AND ($2::uuid IS NULL OR t.project_id = $2)
         GROUP BY t.assignee_id
       ), time_totals AS (
         SELECT e.user_id, sum(e.minutes)::int AS logged
         FROM task_time_entries e LEFT JOIN tasks t ON (t.workspace_id, t.id) = (e.workspace_id, e.task_id)
         CROSS JOIN week LEFT JOIN sprint ON true
         WHERE e.workspace_id = $1 AND ($2::uuid IS NULL OR t.project_id = $2)
           AND (e.logged_at AT TIME ZONE $3)::date BETWEEN COALESCE(sprint.starts_on, week.monday) AND COALESCE(sprint.ends_on, week.monday + 6)
         GROUP BY e.user_id
       )
       SELECT m.user_id AS id, COALESCE(c.open, 0) AS open, COALESCE(c.completed, 0) AS completed,
         COALESCE(c.overdue, 0) AS overdue, COALESCE(c.review, 0) AS review,
         COALESCE(c.assigned, 0) AS "assignedMinutes", COALESCE(l.logged, 0) AS "loggedMinutes",
         m.weekly_capacity_minutes AS "capacityMinutes", m.job_title AS "jobTitle"
       FROM workspace_members m LEFT JOIN task_counts c ON c.assignee_id = m.user_id
       LEFT JOIN time_totals l ON l.user_id = m.user_id
       WHERE m.workspace_id = $1 AND m.status = 'active' AND ($2::uuid IS NULL OR c.assignee_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM project_members p WHERE p.workspace_id = $1 AND p.project_id = $2 AND p.user_id = m.user_id
         UNION ALL
         SELECT 1 FROM projects p WHERE p.workspace_id = $1 AND p.id = $2 AND p.owner_id = m.user_id
       ))`,
      [workspaceId, filter, timezone],
    );
    return rows;
  }

  @Patch('members/:id/weekly-capacity')
  async updateMemberCapacity(@Req() request: Request, @Param('id') id: string, @Body() body?: Input) {
    const { workspaceId, userId, canViewAdministration } = await this.workspace(request);
    if (!canViewAdministration) throw new ForbiddenException('Workspace administrator access is required.');
    const { rows: [member] } = await this.db.pool.query(
      `UPDATE workspace_members SET weekly_capacity_minutes = $3, updated_by = $4, updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND user_id = $2 RETURNING weekly_capacity_minutes AS "capacityMinutes"`,
      [workspaceId, uuid(id), wholeMinutes(body?.capacityMinutes, 'weekly capacity', 0), userId],
    );
    if (!member) throw new NotFoundException('Workspace member not found.');
    return member;
  }

  @Get('members')
  async listMembers(@Req() request: Request) {
    const { workspaceId } = await this.workspace(request);
    const { rows } = await this.db.pool.query<{
      id: string;
      name: string;
      email: string;
      role: string;
    }>(
      `SELECT m.user_id AS id, m.name, m.email, m.role
       FROM workspace_people m WHERE m.workspace_id = $1 ORDER BY m.name, m.user_id`,
      [workspaceId],
    );
    return rows;
  }

  @Get('members/:id')
  async getMember(@Req() request: Request, @Param('id') id: string) {
    const { workspaceId } = await this.workspace(request);
    const { rows: [member] } = await this.db.pool.query(
      `SELECT m.user_id AS id, m.name, m.email, m.role, m.created_at AS "joinedAt"
       FROM workspace_people m WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, uuid(id)],
    );
    if (!member) throw new NotFoundException('Workspace member not found.');
    return member;
  }

  @Post('members')
  async createMember(@Req() request: Request, @Body() body?: Input) {
    const { id, name, role } = await this.users.create(await this.administrator(request), { name: body?.name, email: body?.email });
    return { id, name, role };
  }
}
