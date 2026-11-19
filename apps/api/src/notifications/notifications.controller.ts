import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode,
  NotFoundException, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Auth0Guard } from '../auth/auth0.guard';
import { WorkspaceIdentityService } from '../auth/workspace-identity.service';
import { Public } from '../common/decorators/public.decorator';
import { DatabaseService } from '../database/database.service';
import { uuid } from '../dashboard/workspace-input';

const preferenceTypes = ['assignment', 'deadline', 'comment', 'membership'] as const;
const notificationTypes = [...preferenceTypes, 'status'];
const pageSize = 25;

@Public()
@Controller()
export class NotificationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly workspaceIdentity: WorkspaceIdentityService,
    private readonly auth: Auth0Guard,
  ) {}

  private async recipient(request: Request): Promise<[string, string]> {
    const { workspaceId, userId } = await this.workspaceIdentity.resolve(request);
    return [workspaceId, userId];
  }

  @Get('notifications/workspaces')
  @Header('Cache-Control', 'no-store')
  async workspaces(@Req() request: Request) {
    const { issuer, subject } = await this.auth.authenticate(request);
    const { rows } = await this.db.pool.query<{ id: string; name: string }>(
      `SELECT w.id, w.name FROM user_identities i
       JOIN workspace_members m ON m.user_id = i.user_id
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE i.issuer = $1 AND i.subject = $2 AND m.status = 'active' ORDER BY w.name, w.id`,
      [issuer, subject],
    );
    return rows;
  }

  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  async list(
    @Req() request: Request,
    @Query('type') type?: typeof notificationTypes[number],
    @Query('unread') unread?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const recipient = await this.recipient(request);
    if (type !== undefined && !notificationTypes.includes(type)) throw new BadRequestException('Invalid notification type.');
    if (unread !== undefined && !['true', 'false'].includes(unread)) throw new BadRequestException('Invalid unread filter.');
    if (limit !== undefined && (typeof limit !== 'string' || !/^(?:[1-9]|1[0-9]|2[0-5])$/.test(limit))) {
      throw new BadRequestException('Provide a notification limit between 1 and 25.');
    }
    const size = limit === undefined ? pageSize : Number(limit);
    const { rows: [page] } = await this.db.pool.query<{
      items: { id: string }[];
      unreadCount: number;
      counts: Record<string, number>;
      validCursor: boolean;
    }>(
      `WITH anchor AS (
         SELECT created_at, id FROM notifications
         WHERE workspace_id = $1 AND recipient_user_id = $2 AND id = $5
       ), page AS (
         SELECT n.id, n.type, n.title, n.body, n.entity_type AS "entityType",
           n.entity_id AS "entityId", n.created_at AS "createdAt", n.read_at AS "readAt"
         FROM notifications n
         WHERE n.workspace_id = $1 AND n.recipient_user_id = $2
           AND ($3::text IS NULL OR n.type = $3)
           AND (NOT $4::boolean OR n.read_at IS NULL)
           AND ($5::uuid IS NULL OR (n.created_at, n.id) < (SELECT created_at, id FROM anchor))
         ORDER BY n.created_at DESC, n.id DESC LIMIT $6
       ), totals AS (
         SELECT type, count(*)::int AS count, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM notifications WHERE workspace_id = $1 AND recipient_user_id = $2 GROUP BY type
       )
       SELECT COALESCE((SELECT jsonb_agg(page ORDER BY "createdAt" DESC, id DESC) FROM page), '[]') AS items,
         COALESCE((SELECT sum(unread)::int FROM totals), 0) AS "unreadCount",
         COALESCE((SELECT jsonb_object_agg(type, count) FROM totals), '{}') AS counts,
         ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM anchor)) AS "validCursor"`,
      [...recipient, type ?? null, unread === 'true', cursor === undefined ? null : uuid(cursor), size + 1],
    );
    if (!page.validCursor) throw new NotFoundException('Notification cursor not found.');
    const items = page.items.slice(0, size);
    return { items, unreadCount: page.unreadCount, counts: page.counts, nextCursor: page.items.length > size ? items[size - 1].id : null };
  }

  @Patch('notifications/:id/read')
  @HttpCode(204)
  async markRead(@Req() request: Request, @Param('id') id: string) {
    const recipient = await this.recipient(request);
    const result = await this.db.pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, clock_timestamp())
       WHERE workspace_id = $1 AND recipient_user_id = $2 AND id = $3`,
      [...recipient, uuid(id)],
    );
    if (!result.rowCount) throw new NotFoundException('Notification not found.');
  }

  @Post('notifications/read-all')
  @HttpCode(204)
  async markAllRead(@Req() request: Request) {
    const recipient = await this.recipient(request);
    await this.db.pool.query(
      `UPDATE notifications SET read_at = clock_timestamp()
       WHERE workspace_id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
      recipient,
    );
  }

  @Get('notification-preferences')
  @Header('Cache-Control', 'no-store')
  async preferences(@Req() request: Request) {
    const recipient = await this.recipient(request);
    const { rows } = await this.db.pool.query<{ eventType: string; enabled: boolean }>(
      `SELECT event_type AS "eventType", in_app_enabled AS enabled FROM notification_preferences
       WHERE workspace_id = $1 AND user_id = $2`,
      recipient,
    );
    return Object.fromEntries(preferenceTypes.map((type) => [type, rows.find((row) => row.eventType === type)?.enabled ?? true]));
  }

  @Patch('notification-preferences')
  @HttpCode(204)
  async updatePreferences(@Req() request: Request, @Body() body: unknown) {
    const recipient = await this.recipient(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid preferences.');
    const entries = Object.entries(body);
    if (!entries.length || entries.some(([key, value]) => !preferenceTypes.some((type) => type === key) || typeof value !== 'boolean')) {
      throw new BadRequestException('Invalid preferences.');
    }
    await this.db.pool.query(
      `INSERT INTO notification_preferences (workspace_id, user_id, event_type, in_app_enabled)
       SELECT $1, $2, key, value::boolean FROM jsonb_each_text($3::jsonb) ORDER BY key
       ON CONFLICT (workspace_id, user_id, event_type)
       DO UPDATE SET in_app_enabled = EXCLUDED.in_app_enabled`,
      [...recipient, JSON.stringify(body)],
    );
  }
}
