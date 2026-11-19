import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { optionalText, requiredText, uuid } from './workspace-input';
import { customRolePrefix, displayWorkspaceRole, hasWorkspaceAdminRole, workspaceRoleKey, workspaceRoles } from './workspace-roles';

const statuses = ['active', 'inactive', 'pending_invitation'];
const sortOrders = new Map([
  ['name', 'lower(name), id'],
  ['employee', '"employeeId", id'],
  ['department', 'lower(department) NULLS LAST, lower(name), id'],
  ['status', 'status, lower(name), id'],
]);
const pageSize = 5;
const peopleJoin = `FROM workspace_people m
  LEFT JOIN workspace_departments d ON (d.workspace_id, d.id) = (m.workspace_id, m.department_id)
  LEFT JOIN workspace_people manager ON (manager.workspace_id, manager.user_id) = (m.workspace_id, m.manager_id)
  LEFT JOIN workspace_role_permissions r ON r.workspace_id = m.workspace_id AND m.role = '${customRolePrefix}' || r.key`;
const peopleColumns = `m.user_id AS id, m.name, m.email, m.role, r.name AS "customRole", m.status,
  m.employee_id AS "employeeId", m.job_title AS "jobTitle", m.department_id AS "departmentId",
  d.name AS department, m.manager_id AS "managerId", manager.name AS manager, m.created_at AS "joinedAt"`;
type Input = Record<string, unknown>;
type AccountContext = { workspaceId: string; userId: string };
type Context = AccountContext & { role: string; timezone: string };
type Person = {
  id: string; name: string; email: string; role: string; customRole: string | null; status: string; employeeId: string;
  jobTitle: string | null; departmentId: string | null; department: string | null; managerId: string | null; manager: string | null; joinedAt: string;
};

function contactEmail(value: unknown) {
  const email = requiredText(value, 'a work email address', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid email address.');
  return email;
}

function membershipStatus(value: unknown) {
  if (typeof value !== 'string' || !statuses.includes(value)) throw new BadRequestException('Choose a valid user status.');
  return value;
}

function roleKey(value: string) {
  return value.startsWith(customRolePrefix) ? value.slice(customRolePrefix.length) : workspaceRoleKey(value);
}

function personResult({ customRole, ...person }: Person, workspace: Context) {
  return {
    ...person, roleKey: roleKey(person.role), roleLabel: displayWorkspaceRole(person.role, customRole),
    canEditProfile: hasWorkspaceAdminRole(workspace.role),
    canManageAccess: hasWorkspaceAdminRole(workspace.role) && person.id !== workspace.userId && person.role.toLowerCase() !== 'owner' &&
      (!hasWorkspaceAdminRole(person.role) || workspace.role.toLowerCase() === 'owner'),
  };
}

@Injectable()
export class WorkspaceUsersService {
  constructor(private readonly db: DatabaseService) {}

  async directory(workspace: Context, query: Input) {
    const search = optionalText(query.search, 'a search term', 200);
    const department = query.department ? uuid(query.department) : null;
    const status = query.status ? membershipStatus(query.status) : null;
    const order = sortOrders.get(String(query.sort ?? 'name'));
    if (!order) throw new BadRequestException('Choose a supported sort order.');
    const requestedPage = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 200000) throw new BadRequestException('Choose a valid page.');
    const { rows: [data] } = await this.db.pool.query<{
      items: Person[]; total: number; page: number; summary: Record<string, number>; departments: { id: string; name: string }[];
    }>(
      `WITH people AS (
         SELECT ${peopleColumns} ${peopleJoin} WHERE m.workspace_id = $1
       ), filtered AS (
         SELECT * FROM people WHERE ($2::text IS NULL OR strpos(lower(concat_ws(' ', name, email, "employeeId")), lower($2)) > 0)
           AND ($3::uuid IS NULL OR "departmentId" = $3) AND ($4::text IS NULL OR status = $4)
       ), tally AS (
         SELECT count(*)::int AS total,
           LEAST($5::int, GREATEST(1, ceil(count(*)::numeric / $6::int)::int)) AS page FROM filtered
       ), page AS (
         SELECT * FROM filtered ORDER BY ${order} LIMIT $6 OFFSET (SELECT (page - 1) * $6 FROM tally)
       ), departments AS (
         SELECT id, name FROM workspace_departments WHERE workspace_id = $1
       )
       SELECT tally.total, tally.page, COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY ${order}) FROM page p), '[]') AS items,
         jsonb_build_object('active', (SELECT count(*) FROM people WHERE status = 'active'),
           'inactive', (SELECT count(*) FROM people WHERE status = 'inactive'),
           'pending_invitation', (SELECT count(*) FROM people WHERE status = 'pending_invitation'),
           'departments', (SELECT count(*) FROM departments)) AS summary,
         COALESCE((SELECT jsonb_agg(departments ORDER BY name, id) FROM departments), '[]') AS departments
       FROM tally`, [workspace.workspaceId, search, department, status, requestedPage, pageSize],
    );
    return { ...data, pageSize, items: data.items.map(person => personResult(person, workspace)) };
  }

  async options(workspace: Context) {
    const [departments, managers, customRoles] = await Promise.all([
      this.db.pool.query('SELECT id, name FROM workspace_departments WHERE workspace_id = $1 ORDER BY name, id', [workspace.workspaceId]),
      this.db.pool.query("SELECT user_id AS id, name FROM workspace_people WHERE workspace_id = $1 AND status = 'active' ORDER BY name, id", [workspace.workspaceId]),
      this.db.pool.query('SELECT key, name FROM workspace_role_permissions WHERE workspace_id = $1 ORDER BY name, key', [workspace.workspaceId]),
    ]);
    const canAssignAdmin = workspace.role.toLowerCase() === 'owner';
    return {
      departments: departments.rows, managers: managers.rows,
      roles: [
        ...workspaceRoles.filter(({ key }) => canAssignAdmin || key !== 'system-admin').map(({ key, name }) => ({ key, name })),
        ...customRoles.rows.filter(role => !workspaceRoles.some(item => item.key === role.key)),
      ],
    };
  }

  async detail(workspace: Context, id: string) {
    const person = await this.getPerson(this.db.pool, workspace.workspaceId, id);
    const [workload, projects] = await Promise.all([
      this.db.pool.query(
        `WITH week AS (SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE $3)::date AS starts)
         SELECT m.weekly_capacity_minutes AS "capacityMinutes", count(t.id)::int AS assigned,
           count(*) FILTER (WHERE lower(t.status) IN ('done', 'completed', 'complete'))::int AS completed,
           count(*) FILTER (WHERE lower(t.status) = 'blocked')::int AS blocked,
           COALESCE(sum(t.estimate_minutes) FILTER (WHERE t.due_date >= week.starts AND t.due_date < week.starts + 7), 0)::int AS "assignedMinutes"
         FROM workspace_members m CROSS JOIN week
         LEFT JOIN tasks t ON (t.workspace_id, t.assignee_id) = (m.workspace_id, m.user_id)
         WHERE m.workspace_id = $1 AND m.user_id = $2 GROUP BY m.weekly_capacity_minutes`,
        [workspace.workspaceId, id, workspace.timezone],
      ),
      this.db.pool.query(
        `WITH assigned AS (
           SELECT project_id, count(*)::int AS tasks FROM tasks WHERE workspace_id = $1 AND assignee_id = $2 GROUP BY project_id
         )
         SELECT p.id, p.name, COALESCE(a.tasks, 0) AS tasks,
           CASE WHEN p.owner_id = $2 THEN 'Owner' WHEN pm.user_id IS NOT NULL THEN 'Member' ELSE 'Assignee' END AS role
         FROM projects p LEFT JOIN assigned a ON a.project_id = p.id
         LEFT JOIN project_members pm ON (pm.workspace_id, pm.project_id, pm.user_id) = (p.workspace_id, p.id, $2::uuid)
         WHERE p.workspace_id = $1 AND (p.owner_id = $2 OR pm.user_id IS NOT NULL OR a.project_id IS NOT NULL)
         ORDER BY p.name, p.id`, [workspace.workspaceId, id],
      ),
    ]);
    return { user: personResult(person, workspace), workload: workload.rows[0], projects: projects.rows };
  }

  async accountProfile(workspace: AccountContext) {
    const { workspaceId, userId } = workspace;
    const [person, { rows: [summary] }] = await Promise.all([
      this.getPerson(this.db.pool, workspaceId, userId),
      this.db.pool.query<{ workspaceName: string; activeProjects: number; openTasks: number }>(
        `SELECT w.name AS "workspaceName",
           (SELECT count(*)::int FROM projects p WHERE p.workspace_id = w.id
             AND lower(p.status) NOT IN ('done', 'completed', 'complete', 'archived', 'cancelled', 'canceled')
             AND (p.owner_id = $2 OR EXISTS (
               SELECT 1 FROM project_members pm WHERE pm.workspace_id = w.id AND pm.project_id = p.id AND pm.user_id = $2
             ) OR EXISTS (
               SELECT 1 FROM tasks t WHERE t.workspace_id = w.id AND t.project_id = p.id AND t.assignee_id = $2
             ))) AS "activeProjects",
           (SELECT count(*)::int FROM tasks t WHERE t.workspace_id = w.id AND t.assignee_id = $2
             AND lower(t.status) NOT IN ('done', 'completed', 'complete')) AS "openTasks"
         FROM workspaces w WHERE w.id = $1`, [workspaceId, userId],
      ),
    ]);
    if (person.status !== 'active') throw new ForbiddenException('Workspace membership required.');
    return { id: person.id, name: person.name, email: person.email, status: person.status,
      roleLabel: displayWorkspaceRole(person.role, person.customRole), ...summary };
  }

  async updateAccountProfile(workspace: AccountContext, input?: Input) {
    const fields = Object.keys(input ?? {});
    if (!fields.length || fields.some(field => field !== 'name' && field !== 'email')) {
      throw new BadRequestException('Update a full name or work email address.');
    }
    await this.saveMembership(workspace, workspace.userId, { name: input?.name, email: input?.email }, 'self');
    return this.accountProfile(workspace);
  }

  async create(workspace: Context, input?: Input) {
    const name = requiredText(input?.name, 'a full name', 160);
    const email = contactEmail(input?.email);
    const status = membershipStatus(input?.status ?? 'active');
    const jobTitle = optionalText(input?.jobTitle, 'a designation', 120);
    const departmentId = input?.departmentId ? uuid(input.departmentId) : null;
    const managerId = input?.managerId ? uuid(input.managerId) : null;
    const id = await this.transaction(workspace, async (client, actorRole) => {
      await this.checkEmail(client, workspace.workspaceId, email);
      const role = await this.chooseRole(client, workspace.workspaceId, input?.roleKey ?? 'team-member');
      if (hasWorkspaceAdminRole(role) && actorRole !== 'owner') throw new ForbiddenException('Only a workspace owner can appoint administrators.');
      const { rows: identities } = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = $1 LIMIT 2', [email],
      );
      if (identities.length > 1) throw new ConflictException('That email matches multiple accounts.');
      const { rows: [identity] } = identities.length ? { rows: identities } : await client.query<{ id: string }>(
        `INSERT INTO users (display_name, email) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`, [name, email],
      );
      const id = identity.id;
      await this.department(client, workspace.workspaceId, departmentId);
      await this.manager(client, workspace.workspaceId, id, managerId);
      const { rowCount } = await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, display_name, work_email,
           department_id, job_title, manager_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) ON CONFLICT DO NOTHING`,
        [workspace.workspaceId, id, role, status, name, email, departmentId, jobTitle, managerId, workspace.userId],
      );
      if (!rowCount) throw new ConflictException('This person is already a workspace member.');
      return id;
    });
    return personResult(await this.getPerson(this.db.pool, workspace.workspaceId, id), workspace);
  }

  async update(workspace: Context, id: string, input?: Input) {
    await this.saveMembership(workspace, id, input, 'admin');
    return this.detail(workspace, id);
  }

  private async saveMembership(workspace: AccountContext, id: string, input: Input | undefined, access: 'admin' | 'self') {
    await this.transaction(workspace, async (client, actorRole) => {
      const current = await this.getPerson(client, workspace.workspaceId, id);
      const name = input?.name === undefined ? current.name : requiredText(input.name, 'a full name', 160);
      const email = input?.email === undefined ? current.email : contactEmail(input.email);
      const status = input?.status === undefined ? current.status : membershipStatus(input.status);
      const jobTitle = input?.jobTitle === undefined ? current.jobTitle : optionalText(input.jobTitle, 'a designation', 120);
      const departmentId = input?.departmentId === undefined ? current.departmentId : input.departmentId ? uuid(input.departmentId) : null;
      const managerId = input?.managerId === undefined ? current.managerId : input.managerId ? uuid(input.managerId) : null;
      const role = input?.roleKey === undefined || input.roleKey === roleKey(current.role) ? current.role :
        await this.chooseRole(client, workspace.workspaceId, input.roleKey);
      const accessChanged = role !== current.role || status !== current.status;
      if (accessChanged && (id === workspace.userId || current.role.toLowerCase() === 'owner')) {
        throw new ForbiddenException('The role and status of this account are protected.');
      }
      if (accessChanged && (hasWorkspaceAdminRole(role) || hasWorkspaceAdminRole(current.role)) && actorRole !== 'owner') {
        throw new ForbiddenException('Only a workspace owner can change administrator access.');
      }
      if (email.toLowerCase() !== current.email.toLowerCase()) await this.checkEmail(client, workspace.workspaceId, email, id);
      const department = departmentId === current.departmentId ? current.department : await this.department(client, workspace.workspaceId, departmentId);
      const manager = managerId === current.managerId ? current.manager : await this.manager(client, workspace.workspaceId, id, managerId);
      const fields = [
        ['Full name', name !== current.name, current.name, name],
        ['Work email', email !== current.email, current.email, email],
        ['Department', departmentId !== current.departmentId, current.department, department],
        ['Designation', jobTitle !== current.jobTitle, current.jobTitle, jobTitle],
        ['Manager', managerId !== current.managerId, current.manager, manager],
      ] as const;
      const changes = fields.filter(([, changed]) => changed);
      if (!accessChanged && !changes.length) return;
      await client.query(
        `UPDATE workspace_members SET
           display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
           work_email = CASE WHEN $5::boolean THEN $6 ELSE work_email END,
           role = $7, status = $8, department_id = $9, job_title = $10, manager_id = $11, updated_by = $12, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND user_id = $2`,
        [workspace.workspaceId, id, name !== current.name, name, email !== current.email, email,
          role, status, departmentId, jobTitle, managerId, workspace.userId],
      );
      if (changes.length) await client.query(
        `INSERT INTO workspace_audit (workspace_id, actor_id, module, action, record, fields, previous_values, updated_values)
         VALUES ($1, $2, 'User', 'Updated', $3, $4, $5, $6)`,
        [workspace.workspaceId, workspace.userId, name, changes.map(([field]) => field),
          Object.fromEntries(changes.map(([field, , before]) => [field, before])),
          Object.fromEntries(changes.map(([field, , , after]) => [field, after]))],
      );
    }, access);
  }

  private async getPerson(client: Pick<PoolClient, 'query'>, workspaceId: string, id: string) {
    const { rows: [person] } = await client.query<Person>(
      `SELECT ${peopleColumns} ${peopleJoin} WHERE m.workspace_id = $1 AND m.user_id = $2`, [workspaceId, id],
    );
    if (!person) throw new NotFoundException('Workspace user not found.');
    return person;
  }

  private async checkEmail(client: PoolClient, workspaceId: string, email: string, id?: string) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM workspace_people WHERE workspace_id = $1 AND lower(email) = $2 AND user_id IS DISTINCT FROM $3::uuid', [workspaceId, email, id ?? null],
    );
    if (rowCount) throw new ConflictException('That work email is already used by a workspace user.');
  }

  private async chooseRole(client: PoolClient, workspaceId: string, value: unknown) {
    const key = requiredText(value, 'an application role', 64);
    const role = workspaceRoles.find(item => item.key === key);
    if (role) return role.value;
    const { rowCount } = await client.query('SELECT 1 FROM workspace_role_permissions WHERE workspace_id = $1 AND key = $2', [workspaceId, key]);
    if (!rowCount) throw new BadRequestException('Choose a workspace role.');
    return customRolePrefix + key;
  }

  private async department(client: PoolClient, workspaceId: string, id: string | null) {
    if (!id) return null;
    const { rows: [item] } = await client.query<{ name: string }>(
      'SELECT name FROM workspace_departments WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE', [workspaceId, id],
    );
    if (!item) throw new NotFoundException('Department not found.');
    return item.name;
  }

  private async manager(client: PoolClient, workspaceId: string, id: string, managerId: string | null) {
    if (!managerId) return null;
    if (id === managerId) throw new ConflictException('A person cannot be their own manager.');
    const { rows: [item] } = await client.query<{ name: string; cycle: boolean }>(
      `WITH RECURSIVE chain AS (
         SELECT user_id, manager_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
         UNION
         SELECT m.user_id, m.manager_id FROM workspace_members m JOIN chain ON m.user_id = chain.manager_id WHERE m.workspace_id = $1
       ) SELECT name, EXISTS (SELECT 1 FROM chain WHERE user_id = $3) AS cycle
       FROM workspace_people WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`, [workspaceId, managerId, id],
    );
    if (!item) throw new NotFoundException('Active reporting manager not found.');
    if (item.cycle) throw new ConflictException('That manager assignment would create a reporting cycle.');
    return item.name;
  }

  private async transaction<T>(
    workspace: AccountContext, operation: (client: PoolClient, actorRole: string) => Promise<T>, access: 'admin' | 'self' = 'admin',
  ) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [workspace.workspaceId]);
      const { rows: [actor] } = await client.query<{ role: string }>(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'", [workspace.workspaceId, workspace.userId],
      );
      if (!actor) throw new ForbiddenException('Workspace membership required.');
      if (access === 'admin' && !hasWorkspaceAdminRole(actor.role)) throw new ForbiddenException('Workspace administrator access is required.');
      const result = await operation(client, actor.role.toLowerCase());
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
