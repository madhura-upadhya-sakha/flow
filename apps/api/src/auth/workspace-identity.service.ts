import { PasswordSessionService } from './password-session.service';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import { uuid } from '../dashboard/workspace-input';
import { Auth0Guard } from './auth0.guard';
import { localWorkspaceIdentity } from './local-workspace';

@Injectable()
export class WorkspaceIdentityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly auth: Auth0Guard,
    private readonly passwords: PasswordSessionService,
  ) {}

  async resolve(request: Request) {
    if (!request.headers.authorization && this.passwords.enabled) return this.passwords.resolve(request);

    const local = !request.headers.authorization && localWorkspaceIdentity(this.config, request);
    if (local) {
      const result = await this.db.pool.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
        [local.workspaceId, local.userId],
      );
      if (!result.rowCount) throw new ForbiddenException('Workspace membership required.');
      return { ...local, session: 'local' as const };
    }

    const { issuer, subject } = await this.auth.authenticate(request);
    const workspace = request.headers['x-workspace-id'];
    const { rows } = await this.db.pool.query<{ workspaceId: string; userId: string }>(
      `SELECT m.workspace_id AS "workspaceId", m.user_id AS "userId"
       FROM user_identities i JOIN workspace_members m ON m.user_id = i.user_id
       WHERE i.issuer = $1 AND i.subject = $2 AND m.status = 'active' AND ($3::uuid IS NULL OR m.workspace_id = $3)
       LIMIT 2`,
      [issuer, subject, workspace === undefined ? null : uuid(workspace)],
    );
    if (!rows.length) throw new ForbiddenException('Workspace membership required.');
    if (rows.length > 1) throw new BadRequestException('Select a workspace using X-Workspace-Id.');
    return { ...rows[0], session: 'auth0' as const };
  }
}
