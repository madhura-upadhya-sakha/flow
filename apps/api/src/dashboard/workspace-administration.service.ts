import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { customRolePrefix, displayWorkspaceRole, workspaceRoles } from './workspace-roles';
import { dueDate, optionalText, requiredText, uuid } from './workspace-input';

const modules = ['Projects & tasks', 'User management', 'Organization', 'Roles & permissions', 'Task imports', 'Audit logs'];
const actions = ['View', 'Create', 'Edit', 'Delete', 'Assign', 'Import', 'Export', 'Approve'];
const allPermissions = modules.flatMap(module => actions.map(action => permissionKey(module, action)));
const presetPermissions: Record<string, string[]> = {
  'system-admin': allPermissions,
  'department-head': ['Projects & tasks:View', 'Projects & tasks:Approve', 'User management:View', 'Organization:View'],
  'project-manager': [
    'Organization:View', 'Task imports:View', 'Task imports:Import',
    ...actions.filter(action => action !== 'Import' && action !== 'Export').map(action => permissionKey(modules[0], action)),
  ],
  'team-lead': ['Projects & tasks:View', 'Projects & tasks:Edit', 'Projects & tasks:Assign'],
  'team-member': ['Projects & tasks:View'],
};
const defaults = workspaceRoles.map(role => ({ ...role, permissions: presetPermissions[role.key] }));
type Input = Record<string, unknown>;
type AdminContext = { workspaceId: string; userId: string; workspaceName: string; timezone: string };
type Role = { key: string; name: string; permissions: string[] };

function permissionKey(module: string, action: string) {
  return `${module}:${action}`;
}

@Injectable()
export class WorkspaceAdministrationService {
  constructor(private readonly db: DatabaseService) {}

  async organization(workspace: AdminContext) {
    const [peopleResult, departmentResult, projectResult] = await Promise.all([
      this.db.pool.query(
        `SELECT m.user_id AS id, m.name, m.role, r.name AS "customRole", m.job_title AS "jobTitle",
           m.department_id AS "departmentId", d.name AS department, m.manager_id AS "managerId"
         FROM workspace_people m
         LEFT JOIN workspace_role_permissions r ON (r.workspace_id, '${customRolePrefix}' || r.key) = (m.workspace_id, m.role)
         LEFT JOIN workspace_departments d ON (d.workspace_id, d.id) = (m.workspace_id, m.department_id)
         WHERE m.workspace_id = $1 ORDER BY m.name, m.user_id`,
        [workspace.workspaceId],
      ),
      this.departments(workspace),
      this.db.pool.query('SELECT count(*)::int AS count FROM projects WHERE workspace_id = $1', [workspace.workspaceId]),
    ]);
    const people = peopleResult.rows.map(({ customRole, ...person }) => ({ ...person, role: displayWorkspaceRole(person.role, customRole) }));
    return { kind: 'organization', name: workspace.workspaceName, timezone: workspace.timezone,
      members: people.length, projects: projectResult.rows[0].count, departments: departmentResult.items.length,
      managers: new Set(people.flatMap(({ managerId }) => managerId ? [managerId] : [])).size,
      people, departmentOptions: departmentResult.items.map(({ id, name }) => ({ id, name })),
    };
  }

  async departments({ workspaceId }: AdminContext) {
    const { rows } = await this.db.pool.query(
      `SELECT d.id, d.name, d.description, d.lead_id AS "leadId", u.name AS lead,
          count(m.user_id)::int AS members, COALESCE(sum(m.weekly_capacity_minutes), 0)::int AS "capacityMinutes"
       FROM workspace_departments d LEFT JOIN workspace_people u ON (u.workspace_id, u.user_id) = (d.workspace_id, d.lead_id)
       LEFT JOIN workspace_members m ON (m.workspace_id, m.department_id) = (d.workspace_id, d.id)
       WHERE d.workspace_id = $1 GROUP BY d.id, u.name ORDER BY d.name, d.id`,
      [workspaceId],
    );
    return { kind: 'departments', items: rows };
  }

  async saveDepartment(workspace: AdminContext, input?: Input, id?: string) {
    const name = requiredText(input?.name, 'a department name', 100);
    const description = optionalText(input?.description, 'a description', 1000);
    const leadId = input?.leadId ? uuid(input.leadId) : null;
    await this.transaction(workspace, async (client) => {
      const lead = leadId ? await this.requireMember(client, workspace.workspaceId, leadId) : null;
      const previous = id ? (await client.query(
        `SELECT d.name, d.description, d.lead_id AS "leadId", u.name AS lead
         FROM workspace_departments d LEFT JOIN workspace_people u ON (u.workspace_id, u.user_id) = (d.workspace_id, d.lead_id)
         WHERE d.workspace_id = $1 AND d.id = $2 FOR UPDATE OF d`, [workspace.workspaceId, id],
      )).rows[0] : null;
      if (id && !previous) throw new NotFoundException('Department not found.');
      const duplicate = await client.query(`SELECT id FROM workspace_departments WHERE workspace_id = $1
        AND lower(name) = lower($2) AND id IS DISTINCT FROM $3::uuid`, [workspace.workspaceId, name, id ?? null]);
      if (duplicate.rowCount) throw new ConflictException('That department name is already in use.');
      const updated = { Name: name, Description: description, 'Department lead': lead?.name ?? null };
      const before = previous && { Name: previous.name, Description: previous.description, 'Department lead': previous.lead };
      const fields = (['Name', 'Description', 'Department lead'] as const).filter(field =>
        !before || (field === 'Department lead' ? previous.leadId !== leadId : before[field] !== updated[field]));
      if (!fields.length) return;
      if (id) await client.query(
        'UPDATE workspace_departments SET name = $2, description = $3, lead_id = $4 WHERE workspace_id = $1 AND id = $5',
        [workspace.workspaceId, name, description, leadId, id],
      );
      else await client.query(
        'INSERT INTO workspace_departments (workspace_id, name, description, lead_id) VALUES ($1, $2, $3, $4)',
        [workspace.workspaceId, name, description, leadId],
      );
      await this.auditChange(client, workspace, 'Organization', id ? 'Updated' : 'Created', name, ['Department'],
        before && Object.fromEntries(fields.map(field => [field, before[field]])),
        Object.fromEntries(fields.map(field => [field, updated[field]])));
    });
    return this.departments(workspace);
  }

  async updateReporting(workspace: AdminContext, id: string, input?: Input) {
    await this.transaction(workspace, async (client) => {
      const person = await this.requireMember(client, workspace.workspaceId, id);
      const manager = input?.managerId;
      const department = input?.departmentId;
      const managerId = manager === undefined ? person.managerId : manager ? uuid(manager) : null;
      const departmentId = department === undefined ? person.departmentId : department ? uuid(department) : null;
      const jobTitle = input?.jobTitle === undefined ? person.jobTitle : optionalText(input.jobTitle, 'a job title', 120);
      const managerName = managerId ? (await this.requireMember(client, workspace.workspaceId, managerId)).name : null;
      if (managerId) {
        const { rows: [chain] } = await client.query(
          `WITH RECURSIVE chain(id, manager) AS (
             SELECT user_id, manager_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2
             UNION
             SELECT m.user_id, m.manager_id FROM workspace_members m JOIN chain ON chain.manager = m.user_id WHERE m.workspace_id = $1
           ) SELECT EXISTS (SELECT 1 FROM chain WHERE id = $3) AS cycle`, [workspace.workspaceId, managerId, id],
        );
        if (chain.cycle) throw new ConflictException('That manager assignment would create a reporting cycle.');
      }
      const targetDepartment = departmentId ? (await client.query(
        'SELECT name FROM workspace_departments WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE', [workspace.workspaceId, departmentId],
      )).rows[0] : null;
      if (departmentId && !targetDepartment) throw new NotFoundException('Department not found.');
      const fields = ([
        ['Manager', managerId !== person.managerId, person.managerName, managerName],
        ['Department', departmentId !== person.departmentId, person.departmentName, targetDepartment?.name ?? null],
        ['Job title', jobTitle !== person.jobTitle, person.jobTitle, jobTitle],
      ] as const).filter(([, changed]) => changed);
      if (!fields.length) return;
      await client.query(
        `UPDATE workspace_members SET manager_id = $3, department_id = $4, job_title = $5, updated_at = CURRENT_TIMESTAMP, updated_by = $6
         WHERE workspace_id = $1 AND user_id = $2`, [workspace.workspaceId, id, managerId, departmentId, jobTitle, workspace.userId],
      );
      await this.auditChange(client, workspace, 'Organization', 'Updated', person.name, fields.map(([field]) => field),
        Object.fromEntries(fields.map(([field, , before]) => [field, before])),
        Object.fromEntries(fields.map(([field, , , after]) => [field, after])));
    });
    return this.organization(workspace);
  }

  async roles({ workspaceId }: AdminContext) {
    const [configured, assigned] = await Promise.all([
      this.db.pool.query<Role>('SELECT key, name, permissions FROM workspace_role_permissions WHERE workspace_id = $1 ORDER BY name, key', [workspaceId]),
      this.db.pool.query<{ role: string; count: number }>(
        'SELECT lower(role) AS role, count(*)::int FROM workspace_members WHERE workspace_id = $1 GROUP BY lower(role)', [workspaceId],
      ),
    ]);
    const byRole = new Map(configured.rows.map(role => [role.key, role]));
    const counts = new Map(assigned.rows.map(({ role, count }) => [role, count]));
    const builtins = defaults.map(({ key, name, aliases, permissions }) => ({
      key, name, permissions: byRole.get(key)?.permissions ?? permissions,
      members: aliases.reduce((sum, role) => sum + (counts.get(role) ?? 0), 0),
    }));
    return { kind: 'roles', modules, actions, items: [...builtins, ...configured.rows
      .filter(role => !defaults.some(builtin => builtin.key === role.key))
      .map(role => ({ ...role, members: (counts.get(customRolePrefix + role.key) ?? 0) + (counts.get(role.name.toLowerCase()) ?? 0) }))] };
  }

  async createRole(workspace: AdminContext, input?: Input) {
    const name = requiredText(input?.name, 'a role name', 64);
    const key = randomUUID();
    await this.transaction(workspace, async client => {
      const duplicate = defaults.some(role => role.name.toLowerCase() === name.toLowerCase()) || (await client.query(
        'SELECT key FROM workspace_role_permissions WHERE workspace_id = $1 AND lower(name) = lower($2)', [workspace.workspaceId, name],
      )).rowCount;
      if (duplicate) throw new ConflictException('That role name is already in use.');
      const permissions = input?.copyFrom === undefined ? [] :
        (await this.getRole(client, workspace.workspaceId, requiredText(input.copyFrom, 'a role', 64))).permissions;
      await client.query('INSERT INTO workspace_role_permissions (workspace_id, key, name, permissions) VALUES ($1, $2, $3, $4)',
        [workspace.workspaceId, key, name, permissions]);
      await this.auditChange(client, workspace, 'Roles', input?.copyFrom ? 'Duplicated' : 'Created', name,
        [], null, { Role: name, Permissions: permissions.length });
    });
    return { ...await this.roles(workspace), selected: key };
  }

  async updatePermission(workspace: AdminContext, key: string, input?: Input) {
    const permission = requiredText(input?.permission, 'a permission', 80);
    const enabled = input?.enabled;
    if (!allPermissions.includes(permission) || typeof enabled !== 'boolean') throw new BadRequestException('Choose a valid permission and state.');
    await this.transaction(workspace, async client => {
      const role = await this.getRole(client, workspace.workspaceId, key);
      const current = role.permissions.includes(permission);
      if (current === enabled) return;
      const permissions = enabled ? [...role.permissions, permission] : role.permissions.filter(item => item !== permission);
      await client.query(`INSERT INTO workspace_role_permissions (workspace_id, key, name, permissions) VALUES ($1, $2, $3, $4)
        ON CONFLICT (workspace_id, key) DO UPDATE SET permissions = EXCLUDED.permissions`, [workspace.workspaceId, key, role.name, permissions]);
      await this.auditChange(client, workspace, 'Roles', enabled ? 'Granted' : 'Revoked', role.name, [permission],
        { [permission]: current }, { [permission]: enabled });
    });
    return this.roles(workspace);
  }

  async audit(workspace: AdminContext, query: Input) {
    const search = optionalText(query.search, 'a search term', 200);
    const module = optionalText(query.module, 'a module', 30);
    const from = dueDate(query.from, 'start date');
    const to = dueDate(query.to, 'end date');
    const cursor = query.cursor ? uuid(query.cursor) : null;
    if (from && to && from > to) throw new BadRequestException('The start date must be on or before the end date.');
    const { rows } = await this.db.pool.query<{ id: string }>(
      `WITH events AS (
         SELECT id, actor_id, action, module, record, created_at, fields
         FROM workspace_audit_events WHERE workspace_id = $1
       )
       SELECT e.id, e.action, e.module, e.record, e.record AS task, e.fields,
         u.display_name AS actor, e.created_at AS "createdAt"
       FROM events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE ($2::text IS NULL OR strpos(lower(concat_ws(' ', e.action, e.module, e.record, u.display_name, array_to_string(e.fields, ' '))), lower($2)) > 0)
         AND ($3::text IS NULL OR e.module = $3)
         AND ($4::date IS NULL OR e.created_at >= ($4::date::timestamp AT TIME ZONE $6))
         AND ($5::date IS NULL OR e.created_at < (($5::date + 1)::timestamp AT TIME ZONE $6))
         AND ($7::uuid IS NULL OR (e.created_at, e.id) < (SELECT created_at, id FROM events WHERE id = $7))
       ORDER BY e.created_at DESC, e.id DESC LIMIT 26`,
      [workspace.workspaceId, search, module, from, to, workspace.timezone, cursor],
    );
    return { kind: 'audit', items: rows.slice(0, 25), nextCursor: rows.length > 25 ? rows[24].id : null, timezone: workspace.timezone };
  }

  async auditDetails({ workspaceId }: AdminContext, id: string) {
    const { rows: [detail] } = await this.db.pool.query(
      `SELECT e.source, e.previous_values AS "previousValues", e.updated_values AS "updatedValues"
       FROM workspace_audit_events e WHERE e.workspace_id = $1 AND e.id = $2`, [workspaceId, id],
    );
    if (!detail) throw new NotFoundException('Audit event not found.');
    return detail;
  }

  private async requireMember(client: PoolClient, workspaceId: string, id: string) {
    const { rows: [person] } = await client.query(
      `SELECT COALESCE(m.display_name, u.display_name) AS name, m.manager_id AS "managerId", m.department_id AS "departmentId", m.job_title AS "jobTitle",
         manager.name AS "managerName", d.name AS "departmentName"
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN workspace_people manager ON (manager.workspace_id, manager.user_id) = (m.workspace_id, m.manager_id)
       LEFT JOIN workspace_departments d ON (d.workspace_id, d.id) = (m.workspace_id, m.department_id)
       WHERE m.workspace_id = $1 AND m.user_id = $2 FOR KEY SHARE OF m`,
      [workspaceId, id],
    );
    if (!person) throw new NotFoundException('Workspace member not found.');
    return person;
  }

  private async getRole(client: PoolClient, workspaceId: string, key: string): Promise<Role> {
    const { rows: [configured] } = await client.query<Role>(
      'SELECT key, name, permissions FROM workspace_role_permissions WHERE workspace_id = $1 AND key = $2', [workspaceId, key],
    );
    const role = configured ?? defaults.find(entry => entry.key === key);
    if (!role) throw new NotFoundException('Role not found.');
    return role;
  }

  private async transaction(workspace: AdminContext, work: (client: PoolClient) => Promise<void>) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [workspace.workspaceId]);
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async auditChange(
    client: PoolClient, workspace: AdminContext, module: string, action: string, record: string,
    fields: string[] = [], previous: Record<string, unknown> | null = null, updated: Record<string, unknown> | null = null,
  ) {
    await client.query(
      `INSERT INTO workspace_audit (workspace_id, actor_id, module, action, record, fields, previous_values, updated_values)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [workspace.workspaceId, workspace.userId, module, action, record, fields, previous, updated],
    );
  }
}
