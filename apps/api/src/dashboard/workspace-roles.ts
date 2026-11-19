export const workspaceRoles = [
  { key: 'system-admin', name: 'System Admin', value: 'admin', aliases: ['owner', 'admin', 'system admin'] },
  { key: 'department-head', name: 'Department Head', value: 'department head', aliases: ['department head'] },
  { key: 'project-manager', name: 'Project Manager', value: 'project manager', aliases: ['project manager'] },
  { key: 'team-lead', name: 'Team Lead', value: 'team lead', aliases: ['team lead'] },
  { key: 'team-member', name: 'Team Member', value: 'member', aliases: ['member', 'team member'] },
];

export const customRolePrefix = 'custom:';

export function workspaceRoleKey(value: string) {
  return workspaceRoles.find(role => role.aliases.includes(value.toLowerCase()))?.key ?? value;
}

export function displayWorkspaceRole(value: string, customName?: string | null) {
  return workspaceRoles.find(role => role.aliases.includes(value.toLowerCase()))?.name ?? customName ?? value;
}

export function hasWorkspaceAdminRole(value: string) {
  return ['owner', 'admin'].includes(value.toLowerCase());
}
