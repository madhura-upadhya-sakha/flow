import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { requiredText, uuid } from './workspace-input';

const defaultStatuses = ['To do', 'In progress', 'In review', 'Blocked', 'Done'];

type BoardTask = { id: string; status: string; boardPosition: number | null };
type MoveInput = {
  status?: unknown;
  beforeId?: unknown;
  expectedStatus?: unknown;
  expectedPosition?: unknown;
  expectedColumn?: unknown;
};

const columnStatus = (status: string) => ['done', 'completed', 'complete'].includes(status.toLowerCase()) ? 'Done' : status;
const boardChanged = () => new ConflictException('The board changed. Review the current order and try again.');

@Injectable()
export class TaskBoardService {
  constructor(private readonly db: DatabaseService) {}

  async move(workspaceId: string, userId: string, taskId: string, input?: MoveInput) {
    const status = requiredText(input?.status, 'a destination status', 64);
    const expectedStatus = requiredText(input?.expectedStatus, 'the original status', 64);
    const beforeId = input?.beforeId === null ? null : uuid(input?.beforeId);
    const expectedPosition = input?.expectedPosition;
    if (expectedPosition !== null && (typeof expectedPosition !== 'number' || !Number.isSafeInteger(expectedPosition) || expectedPosition < 1)) {
      throw new BadRequestException('Provide the original board position.');
    }
    if (!Array.isArray(input?.expectedColumn) || input.expectedColumn.length > 10000 || beforeId === taskId) {
      throw new BadRequestException('Provide the current destination order.');
    }
    const expectedColumn = input.expectedColumn.map(uuid);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      // All moves in this workspace acquire task locks in the same order.
      await client.query('SELECT id FROM tasks WHERE workspace_id = $1 ORDER BY id FOR UPDATE', [workspaceId]);
      const { rows: tasks } = await client.query<BoardTask>(
        `SELECT id, status, board_position AS "boardPosition"
         FROM tasks WHERE workspace_id = $1
         ORDER BY board_position NULLS LAST, due_date NULLS LAST, id`,
        [workspaceId],
      );
      const task = tasks.find((row) => row.id === taskId);
      if (!task) throw new NotFoundException('Task not found.');
      if (task.status !== expectedStatus || task.boardPosition !== expectedPosition) throw boardChanged();
      if (!defaultStatuses.includes(status) && !tasks.some((row) => columnStatus(row.status) === status)) {
        throw new BadRequestException('Choose an existing board column.');
      }

      const currentColumn = tasks.filter((row) => columnStatus(row.status) === status);
      if (expectedColumn.length !== currentColumn.length || currentColumn.some((row, index) => row.id !== expectedColumn[index])) {
        throw boardChanged();
      }
      const orderedIds = currentColumn.map((row) => row.id).filter((id) => id !== taskId);
      const index = beforeId === null ? orderedIds.length : orderedIds.indexOf(beforeId);
      if (index < 0) throw boardChanged();
      orderedIds.splice(index, 0, taskId);
      const sameColumn = columnStatus(task.status) === status;
      const nextStatus = sameColumn ? task.status : status;
      const reordered = sameColumn && currentColumn.some((row, position) => row.id !== orderedIds[position]);

      const { rows: changed } = await client.query(
        `UPDATE tasks t SET board_position = placement.position::integer,
           status = CASE WHEN t.id = $2 THEN $3 ELSE t.status END,
           updated_at = CASE WHEN t.id = $2 AND t.status <> $3 THEN clock_timestamp() ELSE t.updated_at END,
           updated_by = CASE WHEN t.id = $2 AND t.status <> $3 THEN $4 ELSE t.updated_by END
         FROM unnest($5::uuid[]) WITH ORDINALITY AS placement(id, position)
         WHERE t.workspace_id = $1 AND t.id = placement.id
           AND (t.board_position IS DISTINCT FROM placement.position OR (t.id = $2 AND t.status <> $3))
         RETURNING t.id, t.status, t.board_position AS "boardPosition", t.updated_at AS "updatedAt"`,
        [workspaceId, taskId, nextStatus, userId, orderedIds],
      );
      if (reordered) {
        await client.query(
          `INSERT INTO task_activity (workspace_id, task_id, actor_id, action, changed_fields, previous_values, updated_values)
           VALUES ($1, $2, $3, 'updated', ARRAY['Board position'],
             jsonb_build_object('Board position', $4::int), jsonb_build_object('Board position', $5::int))`,
          [workspaceId, taskId, userId, task.boardPosition, index + 1],
        );
      }
      await client.query('COMMIT');
      return changed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
