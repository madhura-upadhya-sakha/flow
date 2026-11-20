import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import { hashPassword, verifyPassword } from './password-hash';

const cookieName = 'flow_session';
const lifetimeMs = 8 * 60 * 60 * 1000;

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class PasswordSessionService {
  private readonly attempts = new Map<string, number>();
  private windowEnd = 0;

  constructor(private readonly db: DatabaseService, private readonly config: ConfigService) {}

  get enabled() {
    return this.config.get('DATABASE_AUTH_ENABLED') === 'true';
  }

  private get workspaceId() {
    return this.config.get<string>('PASSWORD_AUTH_WORKSPACE_ID');
  }

  private get cookieOptions() {
    const origin = this.config.get('WEB_ORIGIN', 'http://localhost:5173');
    return { httpOnly: true, sameSite: 'strict' as const, secure: origin.startsWith('https://'), path: '/' };
  }

  checkOrigin(request: Request) {
    if (request.headers.origin !== this.config.get('WEB_ORIGIN', 'http://localhost:5173')) {
      throw new ForbiddenException('Request origin is not allowed.');
    }
  }

  private limitAttempts(request: Request, action: string) {
    if (Date.now() >= this.windowEnd) {
      this.attempts.clear();
      this.windowEnd = Date.now() + 60_000;
    }
    const key = `${action}:${request.ip}`;
    const count = this.attempts.get(key) ?? 0;
    if (count >= 10 || (!count && this.attempts.size >= 1000)) {
      throw new HttpException('Too many attempts. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.attempts.set(key, count + 1);
  }

  private requestToken(request: Request) {
    return /(?:^|;\s*)flow_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
  }

  async resolve(request: Request) {
    if (!this.enabled) throw new UnauthorizedException('Password sign-in is disabled.');
    if (!['GET', 'HEAD'].includes(request.method)) this.checkOrigin(request);
    const token = this.requestToken(request);
    if (!token || !this.workspaceId) throw new UnauthorizedException('Sign in to continue.');
    const { rows } = await this.db.pool.query<{ userId: string; workspaceId: string }>(
      `SELECT s.user_id AS "userId", m.workspace_id AS "workspaceId"
       FROM password_sessions s JOIN workspace_members m ON m.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP
         AND m.workspace_id = $2 AND m.status = 'active'`,
      [tokenHash(token), this.workspaceId],
    );
    if (!rows[0]) throw new UnauthorizedException('Sign in to continue.');
    return { ...rows[0], session: 'password' as const };
  }

  async login(request: Request, response: Response, body: Record<string, unknown> | undefined) {
    this.checkOrigin(request);
    this.limitAttempts(request, 'login');
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = body?.password;
    if (!email || email.length > 254 || typeof password !== 'string' || !password || password.length > 128) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const { rows } = await this.db.pool.query<{ user_id: string; password_hash: string }>(
      `SELECT p.user_id, p.password_hash FROM user_passwords p JOIN users u ON u.id = p.user_id
       JOIN workspace_members m ON m.user_id = u.id
       WHERE lower(u.email) = lower($1) AND m.workspace_id = $2 AND m.status = 'active'`,
      [email, this.workspaceId],
    );
    const account = rows.length === 1 ? rows[0] : undefined;
    if (!await verifyPassword(password, account?.password_hash) || !account) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const token = randomBytes(32).toString('hex');
    const previous = this.requestToken(request);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT 1 FROM user_passwords WHERE user_id = $1 AND password_hash = $2 FOR UPDATE',
        [account.user_id, account.password_hash]);
      if (!current.rowCount) throw new UnauthorizedException('Invalid email or password.');
      await client.query('DELETE FROM password_sessions WHERE expires_at <= CURRENT_TIMESTAMP OR token_hash = $1',
        [previous ? tokenHash(previous) : null]);
      await client.query('INSERT INTO password_sessions VALUES ($1, $2, $3)',
        [tokenHash(token), account.user_id, new Date(Date.now() + lifetimeMs)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    response.cookie(cookieName, token, { ...this.cookieOptions, maxAge: lifetimeMs });
  }

  async logout(request: Request, response: Response) {
    this.checkOrigin(request);
    const token = this.requestToken(request);
    if (token) await this.db.pool.query('DELETE FROM password_sessions WHERE token_hash = $1', [tokenHash(token)]);
    response.clearCookie(cookieName, this.cookieOptions);
  }

  async changePassword(request: Request, response: Response, body: Record<string, unknown> | undefined) {
    this.limitAttempts(request, 'password');
    const { userId } = await this.resolve(request);
    const { currentPassword, newPassword, confirmPassword } = body ?? {};
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 128 ||
        typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128 ||
        newPassword !== confirmPassword || newPassword === currentPassword) {
      throw new BadRequestException('Enter matching new passwords of 8–128 characters, different from your current password.');
    }
    const { rows: [account] } = await this.db.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_passwords WHERE user_id = $1', [userId]);
    if (!await verifyPassword(currentPassword, account?.password_hash)) {
      throw new BadRequestException('The current password is incorrect.');
    }
    const replacement = await hashPassword(newPassword);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        'UPDATE user_passwords SET password_hash = $1 WHERE user_id = $2 AND password_hash = $3',
        [replacement, userId, account.password_hash],
      );
      if (!updated.rowCount) throw new UnauthorizedException('Sign in again to change your password.');
      await client.query('DELETE FROM password_sessions WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    response.clearCookie(cookieName, this.cookieOptions);
  }
}
