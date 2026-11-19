import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { dueDate, optionalText, requiredText, rethrowTaskScheduleError, uuid } from './workspace-input';

export const maxTaskAttachmentBytes = 5 * 1024 * 1024;
export type TaskUpload = { originalname: string; buffer: Buffer };

const approvals = ['Not required', 'Pending', 'Approved', 'Changes requested'];

@Injectable()
export class TaskDetailsService {
  constructor(private readonly db: DatabaseService) {}

  async details(workspaceId: string, taskId: string) {
    const { rows: [details] } = await this.db.pool.query(
      `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date::text AS "dueDate", t.start_date::text AS "startDate",
           t.assignee_id AS "assigneeId", assignee.name AS assignee,
           t.approval, t.blocking_task_id AS "blockingTaskId", t.estimate_minutes AS "estimateMinutes",
           t.project_id AS "projectId", p.name AS project, COALESCE(reporter.name, account.display_name) AS reporter,
           t.updated_at AS "updatedAt",
           (SELECT COALESCE(sum(minutes), 0)::int FROM task_time_entries
             WHERE workspace_id = t.workspace_id AND task_id = t.id) AS "loggedMinutes",
           (SELECT count(*)::int FROM task_comments WHERE workspace_id = t.workspace_id AND task_id = t.id) AS "commentCount",
           (SELECT count(*)::int FROM task_activity WHERE workspace_id = t.workspace_id AND task_id = t.id) AS "activityCount",
           COALESCE((SELECT jsonb_agg(l.name ORDER BY l.name) FROM task_labels tl
             JOIN labels l ON (l.workspace_id, l.id) = (tl.workspace_id, tl.label_id)
             WHERE tl.workspace_id = t.workspace_id AND tl.task_id = t.id), '[]') AS labels,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status) ORDER BY s.created_at, s.id)
             FROM tasks s WHERE s.workspace_id = t.workspace_id AND s.parent_task_id = t.id), '[]') AS subtasks,
           COALESCE((SELECT jsonb_agg(a.payload ORDER BY a.created_at, a.id) FROM (
             SELECT l.id, l.created_at, jsonb_build_object('id', l.id, 'name', l.name, 'url', l.url) AS payload
             FROM task_attachment_links l WHERE l.workspace_id = t.workspace_id AND l.task_id = t.id
             UNION ALL
             SELECT f.id, f.created_at, jsonb_build_object('id', f.id, 'name', f.name, 'sizeBytes', f.size_bytes)
             FROM task_attachment_files f WHERE f.workspace_id = t.workspace_id AND f.task_id = t.id
           ) a), '[]') AS attachments
       FROM tasks t JOIN projects p ON (p.workspace_id, p.id) = (t.workspace_id, t.project_id)
       LEFT JOIN workspace_people reporter ON (reporter.workspace_id, reporter.user_id) = (t.workspace_id, t.created_by)
       LEFT JOIN users account ON account.id = t.created_by
       LEFT JOIN workspace_people assignee ON (assignee.workspace_id, assignee.user_id) = (t.workspace_id, t.assignee_id)
       WHERE t.workspace_id = $1 AND t.id = $2`,
      [workspaceId, taskId],
    );
    if (!details) throw new NotFoundException('Task not found.');
    return details;
  }

  async update(workspaceId: string, userId: string, taskId: string, input?: Record<string, unknown>) {
    const keys = Object.keys(input ?? {});
    if (keys.length !== 1) throw new BadRequestException('Update one task property at a time.');
    const field = keys[0];
    const value = input?.[field];
    let change: { column: string; value: string | null };
    switch (field) {
      case 'status': change = { column: 'status', value: requiredText(value, 'a task status', 64) }; break;
      case 'description': change = { column: 'description', value: optionalText(value, 'a description', 5000) }; break;
      case 'assigneeId': change = { column: 'assignee_id', value: value === null ? null : uuid(value) }; break;
      case 'startDate': change = { column: 'start_date', value: dueDate(value, 'start date') }; break;
      case 'dueDate': change = { column: 'due_date', value: dueDate(value) }; break;
      case 'priority': change = { column: 'priority', value: optionalText(value, 'a priority', 64) }; break;
      case 'approval': {
        const approval = requiredText(value, 'an approval status', 64);
        if (!approvals.includes(approval)) throw new BadRequestException('Choose a supported approval status.');
        change = { column: 'approval', value: approval };
        break;
      }
      case 'blockingTaskId':
        change = { column: 'blocking_task_id', value: value === null ? null : uuid(value) };
        break;
      default: throw new BadRequestException('Unsupported task property.');
    }

    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      if (field === 'blockingTaskId' && change.value) {
        await client.query('SELECT id FROM tasks WHERE workspace_id = $1 ORDER BY id FOR UPDATE', [workspaceId]);
        const { rows: [check] } = await client.query<{ exists: boolean; cycle: boolean }>(
          `WITH RECURSIVE chain(id, next) AS (
             SELECT id, blocking_task_id FROM tasks WHERE workspace_id = $1 AND id = $3
             UNION
             SELECT t.id, t.blocking_task_id FROM tasks t JOIN chain ON t.id = chain.next WHERE t.workspace_id = $1
           )
           SELECT EXISTS (SELECT 1 FROM chain) AS exists, EXISTS (SELECT 1 FROM chain WHERE id = $2) AS cycle`,
          [workspaceId, taskId, change.value],
        );
        if (!check.exists) throw new NotFoundException('Blocking task not found.');
        if (check.cycle) throw new ConflictException('That dependency would create a cycle.');
      }
      if (field === 'assigneeId' && change.value) {
        const member = await client.query(
          'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR KEY SHARE',
          [workspaceId, change.value],
        );
        if (!member.rowCount) throw new NotFoundException('Assignee not found in this workspace.');
      }
      const updated = await client.query(
        `UPDATE tasks SET ${change.column} = $3, updated_by = $4, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND id = $2 RETURNING id`,
        [workspaceId, taskId, change.value, userId],
      );
      if (!updated.rowCount) throw new NotFoundException('Task not found.');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      rethrowTaskScheduleError(error);
    } finally {
      client.release();
    }
    return this.details(workspaceId, taskId);
  }

  async createSubtask(workspaceId: string, userId: string, taskId: string, input?: Record<string, unknown>) {
    const title = requiredText(input?.title, 'a subtask title', 240);
    const requestId = uuid(input?.requestId);
    const { rows: [task] } = await this.db.pool.query<{ id: string; title: string }>(
      `INSERT INTO tasks (workspace_id, project_id, parent_task_id, subtask_request_id, title, status, created_by, updated_by)
       SELECT workspace_id, project_id, id, $3, $4, 'To do', $5, $5 FROM tasks WHERE workspace_id = $1 AND id = $2
       ON CONFLICT (workspace_id, parent_task_id, subtask_request_id) DO UPDATE SET subtask_request_id = EXCLUDED.subtask_request_id
       RETURNING id, title`,
      [workspaceId, taskId, requestId, title, userId],
    );
    if (!task) throw new NotFoundException('Task not found.');
    if (task.title !== title) throw new ConflictException('This request was already used for another title.');
    return task;
  }

  async attachFile(workspaceId: string, userId: string, taskId: string, file?: TaskUpload) {
    if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > maxTaskAttachmentBytes) {
      throw new BadRequestException('Choose a file between 1 byte and 5 MB.');
    }
    const name = requiredText(file.originalname.split(/[/\\]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, ''), 'an attachment name', 160);
    const digest = createHash('sha256').update(file.buffer).digest('hex');
    const { rows: [saved] } = await this.db.pool.query(
      `WITH attached AS (
         INSERT INTO task_attachment_files (workspace_id, task_id, name, digest, content)
         SELECT workspace_id, id, $3, $4, $5 FROM tasks WHERE workspace_id = $1 AND id = $2
         ON CONFLICT (task_id, name, digest) DO NOTHING
         RETURNING id, workspace_id, task_id, name, size_bytes
       ), activity AS (
         INSERT INTO task_activity (workspace_id, task_id, actor_id, action, changed_fields)
         SELECT workspace_id, task_id, $6, 'updated', ARRAY['Attachment'] FROM attached
       )
       SELECT id, name, size_bytes AS "sizeBytes" FROM attached`,
      [workspaceId, taskId, name, digest, file.buffer, userId],
    );
    if (saved) return saved;
    const { rows: [existing] } = await this.db.pool.query(
      `SELECT id, name, size_bytes AS "sizeBytes" FROM task_attachment_files
       WHERE workspace_id = $1 AND task_id = $2 AND name = $3 AND digest = $4`,
      [workspaceId, taskId, name, digest],
    );
    if (!existing) throw new NotFoundException('Task not found.');
    return existing;
  }

  async attachmentFile(workspaceId: string, taskId: string, fileId: string) {
    const { rows: [file] } = await this.db.pool.query<{ name: string; content: Buffer }>(
      'SELECT name, content FROM task_attachment_files WHERE workspace_id = $1 AND task_id = $2 AND id = $3',
      [workspaceId, taskId, fileId],
    );
    if (!file) throw new NotFoundException('Attachment not found.');
    return file;
  }

  async attachLink(workspaceId: string, taskId: string, input?: Record<string, unknown>) {
    const name = requiredText(input?.name, 'an attachment name', 160);
    const rawUrl = requiredText(input?.url, 'an attachment URL', 2000);
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new BadRequestException('Enter a valid attachment URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new BadRequestException('Use an HTTP or HTTPS attachment URL without credentials.');
    }

    const { rows: [attachment] } = await this.db.pool.query(
      `INSERT INTO task_attachment_links (workspace_id, task_id, name, url)
       SELECT workspace_id, id, $3, $4 FROM tasks WHERE workspace_id = $1 AND id = $2
       ON CONFLICT (task_id, url) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, url`,
      [workspaceId, taskId, name, url.href],
    );
    if (!attachment) throw new NotFoundException('Task not found.');
    return attachment;
  }
}
