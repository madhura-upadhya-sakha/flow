import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { importSource, validateImport, validateImportRow, type ImportRow } from './task-import-csv';
import { optionalText, uuid } from './workspace-input';

type Options = Record<string, unknown>;
type Source =
  | { kind: 'csv'; projectId: string; fileName: string | null; csv: string }
  | { kind: 'xlsx'; projectId: null; fileName: string; rows: Record<string, string>[] };
type PreviewRow = ImportRow & { projectId?: string; project?: string } | { line: number; skipped: true };
type ErrorRow = { line: number; error: string };
const fields = ['title', 'project', 'description', 'status', 'priority', 'due_date', 'assignee_email'];
const jobColumns = `id, project_name AS "projectName", file_name AS "fileName", task_count AS "taskCount",
  jsonb_array_length(errors) AS "failedCount", skipped_count AS "skippedCount", created_at AS "createdAt"`;

function sourceInput(input?: Options): Source {
  const fileName = optionalText(input?.fileName, 'a file name', 255);
  const rows = input?.rows;
  if (rows === undefined) return { kind: 'csv', projectId: uuid(input?.projectId), csv: importSource(input?.csv), fileName };
  if (!fileName || !/\.xlsx$/i.test(fileName) || !Array.isArray(rows) || !rows.length || rows.length > 100) {
    throw new BadRequestException('Choose an Excel workbook with 1 to 100 task rows.');
  }
  const tasks: Record<string, string>[] = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.entries(row).some(([key, value]) =>
      !fields.includes(key) || typeof value !== 'string' || value.includes('\0') || value.length > 10000)) {
      throw new BadRequestException('Use supported text columns in the workbook.');
    }
    return Object.fromEntries(fields.map(key => [key, row[key]?.trim() ?? '']));
  });
  return { kind: 'xlsx', projectId: null, fileName, rows: tasks };
}

@Injectable()
export class TaskImportService {
  constructor(private readonly db: DatabaseService) {}

  private async prepare(client: PoolClient, workspaceId: string, source: Source, lock = false): Promise<PreviewRow[]> {
    const { rows: members } = await client.query<{ id: string; email: string }>(
      `SELECT m.user_id AS id, lower(COALESCE(m.work_email, u.email)) AS email
       FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1
       ${lock ? 'FOR KEY SHARE OF m' : ''}`, [workspaceId],
    );
    const memberIds = new Map(members.map(({ id, email }) => [email, id]));
    const { rows: projects } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE workspace_id = $1 AND ($2::uuid IS NULL OR id = $2)
       ${lock ? 'FOR KEY SHARE' : ''}`, [workspaceId, source.projectId],
    );
    if (source.kind === 'csv') {
      const jobProject = projects[0];
      if (!jobProject) throw new NotFoundException('Project not found.');
      return validateImport(source.csv, memberIds).map(row => ({ ...row, projectId: jobProject.id, project: jobProject.name }));
    }

    return source.rows.map((row, index) => {
      const line = index + 2;
      if (Object.values(row).every(value => !value)) return { line, skipped: true };
      const project = row.project.toLowerCase();
      const matches = projects.filter(({ name, id }) => id === project || name.toLowerCase() === project);
      if (matches.length !== 1) return { line, error: matches.length ? 'Project name is ambiguous. Use its ID.' : 'Choose an existing workspace project.' };
      const validation = validateImportRow(line, field => row[field] ?? '', memberIds);
      if ('error' in validation) return validation;
      return { ...validation, projectId: matches[0].id, project: matches[0].name };
    });
  }

  async preview(workspaceId: string, input?: Options) {
    const source = sourceInput(input);
    const client = await this.db.pool.connect();
    try {
      return { rows: await this.prepare(client, workspaceId, source) };
    } finally {
      client.release();
    }
  }

  async submit(workspaceId: string, userId: string, input?: Options) {
    const requestId = uuid(input?.requestId);
    const source = sourceInput(input);
    const hash = createHash('sha256').update(source.kind === 'csv' ? source.csv : JSON.stringify(source)).digest('hex');
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`${workspaceId}:${userId}`, requestId]);
      const { rows: [existing] } = await client.query(
        `SELECT ${jobColumns}, project_id AS "projectId", source_hash AS "sourceHash"
         FROM task_imports WHERE workspace_id = $1 AND actor_id = $2 AND request_id = $3`, [workspaceId, userId, requestId],
      );
      if (existing) {
        const { projectId, sourceHash, ...job } = existing;
        if (projectId !== source.projectId || sourceHash !== hash) {
          throw new ConflictException('This import request was already used for different contents.');
        }
        await client.query('COMMIT');
        return job;
      }

      const rows = await this.prepare(client, workspaceId, source, true);
      const tasks = rows.filter(row => 'title' in row);
      const errors = rows.filter((row): row is ErrorRow => 'error' in row).map(({ line, error }) => ({ line, error }));
      if (!tasks.length || (errors.length && (source.kind === 'csv' || input?.allowPartial !== true))) {
        throw new UnprocessableEntityException({ message: 'Fix the invalid rows before importing.', rows: errors });
      }
      await client.query(
        `INSERT INTO tasks (workspace_id, project_id, title, description, status, priority, due_date, assignee_id, created_by, updated_by)
         SELECT $1, r."projectId", r.title, r.description, r.status, r.priority, r.due_date, r.assignee_id, $2, $2
         FROM jsonb_to_recordset($3::jsonb)
           AS r("projectId" uuid, title text, description text, status text, priority text, due_date date, assignee_id uuid)`,
        [workspaceId, userId, JSON.stringify(tasks)],
      );
      const projectNames = [...new Set(tasks.map(row => row.project))];
      const { rows: [job] } = await client.query(
        `INSERT INTO task_imports (workspace_id, actor_id, request_id, project_id, project_name, source_hash, task_count, file_name, errors, skipped_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${jobColumns}`,
        [workspaceId, userId, requestId, source.projectId, projectNames.length === 1 ? projectNames[0] : 'Multiple projects',
          hash, tasks.length, source.fileName, JSON.stringify(errors), rows.filter(row => 'skipped' in row).length],
      );
      await client.query('COMMIT');
      return job;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async history(workspaceId: string, cursor?: string) {
    const { rows } = await this.db.pool.query<{ id: string }>(
      `SELECT i.id, i."projectName", i."fileName", i."taskCount", i."failedCount", i."skippedCount", i."createdAt", u.display_name AS actor
       FROM (SELECT ${jobColumns}, workspace_id, actor_id, created_at FROM task_imports) i LEFT JOIN users u ON u.id = i.actor_id
       WHERE i.workspace_id = $1 AND ($2::uuid IS NULL OR (i.created_at, i.id) < (
         SELECT created_at, id FROM task_imports WHERE workspace_id = $1 AND id = $2
       ))
       ORDER BY i.created_at DESC, i.id DESC LIMIT 26`,
      [workspaceId, cursor === undefined ? null : uuid(cursor)],
    );
    return { items: rows.slice(0, 25), nextCursor: rows.length > 25 ? rows[24].id : null };
  }

  async report(workspaceId: string, id: string) {
    const { rows: [job] } = await this.db.pool.query<{ errors: ErrorRow[] }>(
      'SELECT errors FROM task_imports WHERE workspace_id = $1 AND id = $2', [workspaceId, id],
    );
    if (!job) throw new NotFoundException('Import not found.');
    return ['Row,Error', ...job.errors.map(({ line, error }) => `${line},"${error.replaceAll('"', '""')}"`)].join('\r\n') + '\r\n';
  }
}
