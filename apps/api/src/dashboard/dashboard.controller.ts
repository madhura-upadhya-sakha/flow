import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param,
  ParseUUIDPipe, Patch, Post, Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { DatabaseService } from '../database/database.service';

@Public()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly db: DatabaseService, private readonly config: ConfigService) {}

  private async localWorkspace(request: Request) {
    const workspaceId = this.config.get<string>('LOCAL_DASHBOARD_WORKSPACE_ID');
    const userId = this.config.get<string>('LOCAL_DASHBOARD_USER_ID');
    const host = request.headers.host?.replace(/:\d+$/, '');
    const origin = request.headers.origin;
    if (process.env.NODE_ENV === 'production' || !workspaceId || !userId ||
        request.socket.remoteAddress !== '127.0.0.1' || !['localhost', '127.0.0.1'].includes(host ?? '') ||
        (origin && origin !== this.config.get<string>('WEB_ORIGIN', 'http://localhost:5173'))) {
      throw new NotFoundException();
    }
    const { rows } = await this.db.pool.query<{ displayName: string }>(
      'SELECT u.display_name AS "displayName" FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2',
      [workspaceId, userId],
    );
    if (!rows[0]) throw new NotFoundException('Local workspace membership is missing.');
    return { workspaceId, userId, displayName: rows[0].displayName };
  }

  @Get()
  async getDashboard(@Req() request: Request) {
    const workspace = await this.localWorkspace(request);
    const result = await this.db.pool.query(
      `SELECT
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC, p.id) FROM (
          SELECT p.id, p.name, p.description, p.status, p.due_date AS "dueDate", p.created_at,
            ARRAY(SELECT u.display_name FROM project_members m JOIN users u ON u.id = m.user_id
                  WHERE m.project_id = p.id AND m.workspace_id = p.workspace_id ORDER BY u.display_name, u.id) AS members
          FROM projects p WHERE p.workspace_id = $1
        ) p), '[]') AS projects,
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."dueDate" NULLS LAST, t.id) FROM (
          SELECT t.id, t.project_id AS "projectId", t.title, p.name AS project, t.status, t.priority,
            t.assignee_id AS "assigneeId", u.display_name AS assignee, t.due_date AS "dueDate"
          FROM tasks t JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
          LEFT JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = t.assignee_id
          LEFT JOIN users u ON u.id = m.user_id
          WHERE t.workspace_id = $1
        ) t), '[]') AS tasks,
        ARRAY(SELECT u.display_name FROM workspace_members m JOIN users u ON u.id = m.user_id
              WHERE m.workspace_id = $1 ORDER BY u.display_name, u.id) AS members`,
      [workspace.workspaceId],
    );
    return { ...workspace, ...result.rows[0] };
  }

  @Post('projects')
  async createProject(@Req() request: Request, @Body() body?: { name?: unknown; description?: unknown }) {
    const { workspaceId, userId } = await this.localWorkspace(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = body?.description;
    if (!name || name.length > 200) throw new BadRequestException('Enter a project name of up to 200 characters.');
    if (description !== undefined && (typeof description !== 'string' || description.length > 5000)) {
      throw new BadRequestException('Enter a description of up to 5,000 characters.');
    }
    const { rows } = await this.db.pool.query(
      `WITH project AS (
        INSERT INTO projects (workspace_id, name, description, status, owner_id, created_by, updated_by)
        VALUES ($1, $2, $3, 'On track', $4, $4, $4)
        RETURNING id, name, description, status, due_date
      ), membership AS (
        INSERT INTO project_members (project_id, workspace_id, user_id, created_by, updated_by)
        SELECT id, $1, $4, $4, $4 FROM project RETURNING user_id, project_id
      )
      SELECT p.id, p.name, p.description, p.status, p.due_date::text AS "dueDate",
        ARRAY[u.display_name] AS members
      FROM project p JOIN membership m ON m.project_id = p.id JOIN users u ON u.id = m.user_id`,
      [workspaceId, name, typeof description === 'string' ? description.trim() || null : null, userId],
    );
    return rows[0];
  }

  @Patch('tasks/:id')
  async updateTask(
    @Req() request: Request, @Param('id', ParseUUIDPipe) id: string,
    @Body() body?: { done?: unknown },
  ) {
    const { workspaceId, userId } = await this.localWorkspace(request);
    const done = body?.done;
    if (typeof done !== 'boolean') throw new BadRequestException('Provide a boolean completion state.');
    const { rows } = await this.db.pool.query<{ id: string }>(
      `UPDATE tasks SET status = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
       WHERE workspace_id = $3 AND id = $4 RETURNING id`,
      [done ? 'Done' : 'To do', userId, workspaceId, id],
    );
    if (!rows[0]) throw new NotFoundException('Task not found.');
    return rows[0];
  }
}
