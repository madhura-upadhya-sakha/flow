const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'Load the local API environment before running this test.');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname), 'Test requires local PostgreSQL.');

const db = new Client({ connectionString: databaseUrl });
const workspace = randomUUID();
const otherWorkspace = randomUUID();
const recipient = randomUUID();
const otherRecipient = randomUUID();
const foreignMember = randomUUID();
const project = randomUUID();
const task = randomUUID();
const foreignProject = randomUUID();
const foreignTask = randomUUID();
let server;
const createdUsers = [];

async function startServer() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const apiDirectory = path.resolve(__dirname, '../..');
  server = spawn(process.execPath, ['dist/main.js'], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      LOCAL_DASHBOARD_WORKSPACE_ID: workspace,
      LOCAL_DASHBOARD_USER_ID: recipient,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}/api`;
  for (let attempt = 0; attempt < 50 && server.exitCode === null; attempt++) {
    const healthy = await fetch(`${base}/health`).then((response) => response.ok, () => false);
    if (healthy) return base;
    await delay(100);
  }
  throw new Error('Test API did not become ready. Run npm run build first.');
}

async function run() {
  await db.connect();
  try {
    await db.query('INSERT INTO workspaces(id, name) VALUES ($1, $3), ($2, $3)', [workspace, otherWorkspace, 'Notification integration test']);
    await db.query('INSERT INTO users(id, display_name, email) VALUES ($1, $3, $4), ($2, $3, $5)',
      [recipient, otherRecipient, 'Test recipient', `${recipient}@example.invalid`, `${otherRecipient}@example.invalid`]);
    await db.query("INSERT INTO users(id, display_name, email) VALUES ($1, 'Foreign member', $2)",
      [foreignMember, `${foreignMember}@example.invalid`]);
    await db.query("INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [otherWorkspace, foreignMember]);
    await db.query(`INSERT INTO workspace_members(workspace_id, user_id, role)
      VALUES ($1, $3, 'member'), ($1, $4, 'member'), ($2, $3, 'member')`, [workspace, otherWorkspace, recipient, otherRecipient]);
    await db.query("INSERT INTO projects(id, workspace_id, name, status) VALUES ($1, $2, 'Test project', 'On track')", [project, workspace]);
    await db.query('INSERT INTO project_members(project_id, workspace_id, user_id) VALUES ($1, $2, $3)', [project, workspace, recipient]);
    await db.query(`INSERT INTO tasks(id, project_id, workspace_id, title, status, assignee_id)
      VALUES ($1, $2, $3, 'Test task', 'To do', $4)`, [task, project, workspace, recipient]);
    const change = "UPDATE tasks SET status = 'Done', due_date = '2026-12-01' WHERE id = $1";
    await db.query(change, [task]);
    await db.query(change, [task]);
    const otherNotification = randomUUID();
    const foreignNotification = randomUUID();
    await db.query(`INSERT INTO notifications (id, workspace_id, recipient_user_id, type, title, body, entity_type, entity_id)
      VALUES ($1, $3, $5, 'comment', 'Other recipient', '', 'task', $7),
             ($2, $4, $6, 'comment', 'Other workspace', '', 'task', $7)`,
      [otherNotification, foreignNotification, workspace, otherWorkspace, otherRecipient, recipient, task]);

    const api = await startServer();
    async function request(route, status, options) {
      const response = await fetch(`${api}/${route}`, options);
      const body = await response.text();
      assert.equal(response.status, status, `${route}: ${body}`);
      return body ? JSON.parse(body) : undefined;
    }
    await db.query("INSERT INTO projects(id, workspace_id, name, status) VALUES ($1, $2, 'Foreign project', 'On track')", [foreignProject, otherWorkspace]);
    await db.query("INSERT INTO tasks(id, project_id, workspace_id, title, status, assignee_id) VALUES ($1, $2, $3, 'Foreign task', 'To do', $4)",
      [foreignTask, foreignProject, otherWorkspace, recipient]);
    const discussedTask = randomUUID();
    await db.query(`INSERT INTO tasks(id, project_id, workspace_id, title, status, assignee_id)
      VALUES ($1, $2, $3, 'Task with comments', 'To do', $4)`, [discussedTask, project, workspace, otherRecipient]);
    const memberDetails = await request(`dashboard/members/${recipient}`, 200);
    assert.equal(memberDetails.id, recipient);
    assert.equal(memberDetails.role, 'member');
    assert.ok(memberDetails.joinedAt);
    await request(`dashboard/members/${foreignMember}`, 404);
    const ownProfilePath = 'account/profile';
    const account = await request(ownProfilePath, 200);
    assert.deepEqual(account, {
      id: recipient, name: 'Test recipient', email: `${recipient}@example.invalid`, status: 'active',
      roleLabel: 'Team Member', workspaceName: 'Notification integration test', activeProjects: 1, openTasks: 0, session: 'local',
    });
    await request(ownProfilePath, 401, { headers: { Origin: 'http://example.invalid' } });
    const updateOwnContact = (body, status = 200) => request(ownProfilePath, status, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await updateOwnContact({ role: 'owner' }, 400);
    await updateOwnContact({ id: otherRecipient, name: 'Wrong user' }, 400);
    await updateOwnContact({ email: `${otherRecipient}@example.invalid` }, 409);
    const updatedAccount = await updateOwnContact({ name: 'My test profile', email: `work-${recipient}@example.invalid` });
    assert.equal(updatedAccount.name, 'My test profile');
    assert.equal(updatedAccount.email, `work-${recipient}@example.invalid`);
    assert.equal((await request('dashboard', 200)).displayName, 'My test profile');
    const { rows: [foreignProfile] } = await db.query('SELECT name, email FROM workspace_people WHERE workspace_id = $1 AND user_id = $2', [otherWorkspace, recipient]);
    assert.deepEqual(foreignProfile, { name: 'Test recipient', email: `${recipient}@example.invalid` });
    await updateOwnContact({ name: account.name, email: account.email });

    const workload = await request('dashboard/team-workload', 200);
    await request(`dashboard/team-workload?projectId=${foreignProject}`, 404);
    assert.deepEqual(workload.find(({ id }) => id === recipient), { id: recipient, open: 0, completed: 1, overdue: 0, capacityMinutes: 2400, review: 0, assignedMinutes: 0, loggedMinutes: 0, jobTitle: null });
    assert.deepEqual(workload.find(({ id }) => id === otherRecipient), { id: otherRecipient, open: 1, completed: 0, overdue: 0, capacityMinutes: 2400, review: 0, assignedMinutes: 0, loggedMinutes: 0, jobTitle: null });
    const comments = `dashboard/tasks/${discussedTask}/comments`;
    const commentOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const requestId = randomUUID();
    const payload = { ...commentOptions, body: JSON.stringify({ requestId, body: 'Please review this update.' }) };
    const posted = await request(comments, 201, payload);
    assert.equal((await request(comments, 201, payload)).id, posted.id);
    await request(comments, 409, { ...commentOptions, body: JSON.stringify({ requestId, body: 'Different text' }) });
    await request(`dashboard/tasks/${foreignTask}/comments`, 404, payload);
    await request(`dashboard/tasks/${foreignTask}/comments`, 404);
    assert.deepEqual((await request(comments, 200)).items.map(({ id }) => id), [posted.id]);
    const commentNotification = await db.query(`SELECT recipient_user_id FROM notifications
      WHERE workspace_id = $1 AND entity_id = $2 AND type = 'comment'`, [workspace, discussedTask]);
    assert.deepEqual(commentNotification.rows, [{ recipient_user_id: otherRecipient }]);

    const boardOptions = { method: 'PATCH', headers: { 'Content-Type': 'application/json' } };
    const boardPath = `dashboard/tasks/${discussedTask}/board-position`;
    const move = { status: 'Done', beforeId: task, expectedStatus: 'To do', expectedPosition: null, expectedColumn: [task] };
    const firstMove = await request(boardPath, 200, { ...boardOptions, body: JSON.stringify(move) });
    assert.deepEqual(firstMove.map(({ id, boardPosition }) => [id, boardPosition]).sort(), [[discussedTask, 1], [task, 2]].sort());
    await request(boardPath, 409, { ...boardOptions, body: JSON.stringify(move) });
    const reorder = { ...move, beforeId: null, expectedStatus: 'Done', expectedPosition: 1, expectedColumn: [discussedTask, task] };
    await request(boardPath, 200, { ...boardOptions, body: JSON.stringify(reorder) });
    await request(`dashboard/tasks/${foreignTask}/board-position`, 404, { ...boardOptions, body: JSON.stringify(move) });
    const board = await request('dashboard', 200);
    assert.equal(board.tasks.find(({ id }) => id === discussedTask).boardPosition, 2);
    assert.equal(board.tasks.find(({ id }) => id === discussedTask).status, 'Done');
    const activity = await request(`dashboard/tasks/${discussedTask}/activity`, 200);
    assert.deepEqual(activity.items.map(({ action }) => action), ['updated', 'updated', 'commented', 'created']);
    assert.deepEqual(activity.items[0].fields, ['Board position']);
    assert.deepEqual(activity.items[1].fields, ['Status']);
    await request(`dashboard/tasks/${foreignTask}/activity`, 404);

    const inbox = await request('notifications', 200);
    assert.equal(inbox.unreadCount, 4);
    const previewInbox = await request('notifications?limit=3', 200);
    assert.deepEqual(previewInbox.items.map(({ id }) => id), inbox.items.slice(0, 3).map(({ id }) => id));
    assert.equal(previewInbox.unreadCount, 4);
    const lastPreviewPage = await request(`notifications?limit=3&cursor=${previewInbox.nextCursor}`, 200);
    assert.equal(lastPreviewPage.items.length, 1);
    await request('notifications?limit=0', 400);
    await request('notifications?limit=26', 400);
    assert.deepEqual(inbox.items.map((item) => item.type).sort(), ['assignment', 'deadline', 'membership', 'status']);
    const assignments = await request('notifications?type=assignment&unread=true', 200);
    assert.equal(assignments.items.length, 1);
    const assignment = assignments.items[0].id;
    for (const id of [otherNotification, foreignNotification]) {
      await request(`notifications/${id}/read`, 404, { method: 'PATCH' });
      await request(`notifications?cursor=${id}`, 404);
    }
    await request('notifications?type=unknown', 400);
    await request('notifications', 401, { headers: { Origin: 'http://example.invalid' } });
    await request(`notifications/${assignment}/read`, 204, { method: 'PATCH' });
    const { items: [read] } = await request('notifications?type=assignment', 200);
    await request(`notifications/${assignment}/read`, 204, { method: 'PATCH' });
    assert.equal((await request('notifications?type=assignment', 200)).items[0].readAt, read.readAt);

    const preferenceOptions = { method: 'PATCH', headers: { 'Content-Type': 'application/json' } };
    await request('notification-preferences', 400, { ...preferenceOptions, body: '{"deadline":"false"}' });
    await request('notification-preferences', 204, { ...preferenceOptions, body: '{"deadline":false}' });
    assert.equal((await request('notification-preferences', 200)).deadline, false);
    await db.query("UPDATE tasks SET due_date = '2026-12-02' WHERE id = $1", [task]);
    assert.equal((await request('notifications?type=deadline', 200)).items.length, 1);

    await db.query(`INSERT INTO notifications (workspace_id, recipient_user_id, type, title, body, entity_type, entity_id, created_at)
      SELECT $1, $2, 'comment', 'Page test', '', 'task', $3, '2026-01-01' FROM generate_series(1, 26)`,
      [workspace, recipient, task]);
    const first = await request('notifications', 200);
    const second = await request(`notifications?cursor=${first.nextCursor}`, 200);
    assert.equal(first.items.length, 25);
    assert.equal(Object.values(first.counts).reduce((sum, count) => sum + count, 0), 30);
    assert.equal(first.counts.comment, 26);
    assert.equal(second.items.length, 5);
    assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, 30);
    assert.equal(second.nextCursor, null);
    await request('notifications/read-all', 204, { method: 'POST' });
    assert.equal((await request('notifications?unread=true', 200)).unreadCount, 0);
    const others = await db.query('SELECT count(*)::int AS count FROM notifications WHERE id = ANY($1::uuid[]) AND read_at IS NULL',
      [[otherNotification, foreignNotification]]);
    assert.equal(others.rows[0].count, 2);
    const imports = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const importRequest = {
      projectId: project, requestId: randomUUID(),
      csv: 'title,description,assignee_email,due_date\r\n"Imported, task","First line\r\nSecond line",,2026-12-01',
    };
    const submitImport = (path, status, options = importRequest) =>
      request(path, status, { ...imports, body: JSON.stringify(options) });
    const invalid = { ...importRequest, csv: 'title,due_date\nInvalid task,2026-02-30' };
    const invalidPreview = await submitImport('dashboard/imports/preview', 201, invalid);
    assert.equal(invalidPreview.rows[0].line, 2);
    assert.match(invalidPreview.rows[0].error, /valid due date/);
    await submitImport('dashboard/imports', 422, invalid);
    await submitImport('dashboard/imports/preview', 404, { ...importRequest, projectId: foreignProject });
    const preview = await submitImport('dashboard/imports/preview', 201);
    assert.equal(preview.rows[0].title, 'Imported, task');
    assert.equal(preview.rows[0].description, 'First line\nSecond line');
    assert.equal((await request('dashboard/imports', 200)).items.length, 0);
    assert.equal((await request('dashboard', 200)).tasks.some(({ title }) => title === 'Imported, task'), false);
    const [job, retriedJob] = await Promise.all([
      submitImport('dashboard/imports', 201), submitImport('dashboard/imports', 201),
    ]);
    assert.equal(job.id, retriedJob.id);
    assert.equal(job.taskCount, 1);
    await submitImport('dashboard/imports', 409, { ...importRequest, csv: 'title\nDifferent task' });
    const history = await request('dashboard/imports', 200);
    assert.deepEqual(history.items.map(({ id }) => id), [job.id]);
    assert.equal((await request('dashboard', 200)).tasks.filter(({ title }) => title === 'Imported, task').length, 1);
    await db.query("UPDATE tasks SET status = 'Completed' WHERE id = $1", [task]);
    const timePath = `dashboard/tasks/${task}/time-entries`;
    const timeOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const timeEntry = { requestId: randomUUID(), minutes: 75 };
    const savedTime = await request(timePath, 201, { ...timeOptions, body: JSON.stringify(timeEntry) });
    assert.equal((await request(timePath, 201, { ...timeOptions, body: JSON.stringify(timeEntry) })).id, savedTime.id);
    await request(timePath, 409, { ...timeOptions, body: JSON.stringify({ ...timeEntry, minutes: 76 }) });
    await request(`dashboard/tasks/${foreignTask}/time-entries`, 404, { ...timeOptions, body: JSON.stringify(timeEntry) });
    const metrics = await request('dashboard/overview', 200);
    assert.equal(metrics.days.length, 7);
    assert.equal(metrics.days.reduce((sum, { count }) => sum + count, 0), 2);
    assert.equal(metrics.workspaceMinutes, 75);
    assert.equal(metrics.personalMinutes, 75);
    assert.equal((await request('dashboard/unread-notifications', 200)).count, 1);
    await request(`dashboard/tasks/${task}`, 200, { method: 'DELETE' });
    const afterDelete = await request('dashboard/overview', 200);
    assert.equal(afterDelete.days.reduce((sum, { count }) => sum + count, 0), 2);
    assert.equal(afterDelete.personalMinutes, 75);

    assert.equal((await request('dashboard', 200)).activeSprint, null);
    await request('dashboard/administration/users', 403);
    assert.equal((await request(`dashboard/administration/users/${recipient}`, 200)).user.canEditProfile, false);
    await request(`dashboard/administration/users/${otherRecipient}`, 403);
    await request('dashboard/administration/users', 403, { method: 'POST' });
    await request('dashboard/members', 403, { method: 'POST' });
    await request('dashboard/administration/organization', 403);
    await request(`dashboard/administration/audit/${randomUUID()}`, 403);
    await request('dashboard/administration/departments', 403, { method: 'POST' });
    await request('dashboard/administration/roles/system-admin', 403, { method: 'PATCH' });
    const capacityPath = `dashboard/members/${recipient}/weekly-capacity`;
    const capacityRequest = (minutes) => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacityMinutes: minutes }) });
    await request(capacityPath, 403, capacityRequest(1800));
    await db.query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2",
      [workspace, recipient]);
    await db.query(`INSERT INTO workspace_sprints (workspace_id, name, starts_on, ends_on) VALUES
      ($1, 'Expired sprint', (now() AT TIME ZONE 'UTC')::date - 20, (now() AT TIME ZONE 'UTC')::date - 1),
      ($1, 'Sprint 24', (now() AT TIME ZONE 'UTC')::date - 2, (now() AT TIME ZONE 'UTC')::date + 8),
      ($2, 'Other workspace sprint', (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 8)`, [workspace, otherWorkspace]);
    assert.deepEqual((await request('dashboard', 200)).activeSprint, { name: 'Sprint 24', daysRemaining: 8 });
    await db.query("INSERT INTO workspace_departments (workspace_id, name) VALUES ($1, 'Product'), ($2, 'Other department')",
      [workspace, otherWorkspace]);
    const organization = await request('dashboard/administration/organization', 200);
    assert.equal(organization.departments, 1);
    assert.deepEqual((await request('dashboard/administration/departments', 200)).items.map(({ name }) => name), ['Product']);
    const roles = await request('dashboard/administration/roles', 200);
    assert.equal(roles.items.length, 5);
    assert.equal(roles.items.find(({ key }) => key === 'system-admin').members, 1);
    assert.equal(roles.items.find(({ key }) => key === 'team-member').members, 1);
    const audit = await request('dashboard/administration/audit', 200);
    assert.ok(audit.items.length);
    assert.ok(audit.items.every((item) => item.task !== 'Foreign task'));
    const { rows: [dates] } = await db.query(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS today,
      ((now() AT TIME ZONE 'UTC')::date + 7)::text AS next_week`);
    await request(capacityPath, 400, capacityRequest(-5));
    await request(`dashboard/members/${foreignMember}/weekly-capacity`, 404, capacityRequest(1800));
    assert.equal((await request(capacityPath, 200, capacityRequest(1800))).capacityMinutes, 1800);
    const taskInput = { title: 'Capacity task', projectId: project, assigneeId: recipient, status: 'To do', dueDate: dates.today };
    const bodyOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const planned = await request('dashboard/tasks', 201, bodyOptions('POST', { ...taskInput, estimateMinutes: '90' }));
    assert.equal(planned.estimateMinutes, 90);
    const scopedWorkload = await request(`dashboard/team-workload?projectId=${project}`, 200);
    assert.equal(scopedWorkload.find(({ id }) => id === recipient).assignedMinutes, 90);
    await request('dashboard/tasks', 400, bodyOptions('POST', { ...taskInput, estimateMinutes: '10.5' }));
    await request('dashboard/tasks', 201, bodyOptions('POST', { ...taskInput, title: 'Later task', dueDate: dates.next_week, estimateMinutes: 120 }));
    await request('dashboard/tasks', 201, bodyOptions('POST', { ...taskInput, title: 'Unassigned task', assigneeId: null, estimateMinutes: 180 }));
    await db.query('UPDATE tasks SET assignee_id = $2, estimate_minutes = 240, due_date = $3 WHERE id = $1',
      [foreignTask, recipient, dates.today]);
    const moved = await request(`dashboard/tasks/${planned.id}`, 200, bodyOptions('PATCH', { ...taskInput, status: 'In progress' }));
    assert.equal(moved.estimateMinutes, 90);
    const panels = await request('dashboard/workspace-panels', 200);
    assert.equal(panels.capacityMinutes, 4200);
    assert.equal(panels.assignedMinutes, 90);
    assert.equal(panels.activity.length, 5);
    assert.equal(panels.activity[0].taskId, planned.id);
    assert.equal(panels.activity[0].statusAfter, 'In progress');
    assert.equal(panels.activity[0].actor, 'Test recipient');
    assert.ok(!panels.activity.some((event) => event.taskId === foreignTask));
    assert.equal((await request(`dashboard/tasks/${planned.id}`, 200, bodyOptions('PATCH', { ...taskInput, estimateMinutes: '' }))).estimateMinutes, null);
    assert.equal((await request('dashboard/workspace-panels', 200)).assignedMinutes, 0);

    await request(`dashboard/projects/${foreignProject}/overview`, 404);
    const projectDates = { name: 'Overview dates', description: 'Project overview test', status: 'At risk', startDate: dates.today, dueDate: dates.next_week };
    const newProject = await request('dashboard/projects', 201, bodyOptions('POST', projectDates));
    assert.equal(newProject.startDate, dates.today);
    assert.equal(newProject.owner, 'Test recipient');
    assert.equal((await request('dashboard', 200)).projects.find(({ id }) => id === newProject.id).owner, 'Test recipient');
    const overviewWithOwner = await request(`dashboard/projects/${newProject.id}/overview`, 200);
    assert.equal(overviewWithOwner.owner, 'Test recipient');
    assert.equal(overviewWithOwner.contributors[0].id, recipient);
    const { startDate: _omitted, ...withoutStart } = projectDates;
    const keptDate = await request(`dashboard/projects/${newProject.id}`, 200, bodyOptions('PATCH', withoutStart));
    assert.equal(keptDate.startDate, dates.today);
    assert.equal(keptDate.owner, 'Test recipient');
    await request(`dashboard/projects/${newProject.id}`, 400, bodyOptions('PATCH', { ...withoutStart, dueDate: '2000-01-01' }));
    await request(`dashboard/tasks/${planned.id}/time-entries`, 201, { ...timeOptions,
      body: JSON.stringify({ requestId: randomUUID(), minutes: 60 }) });
    await request(`dashboard/tasks/${planned.id}`, 200, bodyOptions('PATCH', { ...taskInput, estimateMinutes: 90 }));
    const projectOverview = await request(`dashboard/projects/${project}/overview`, 200);
    assert.equal(projectOverview.id, project);
    assert.equal(projectOverview.loggedMinutes, 60);
    assert.ok(projectOverview.activity.some((event) => event.taskId === planned.id));
    assert.ok(!projectOverview.activity.some((event) => event.taskId === foreignTask));
    assert.equal(projectOverview.contributors.find(({ id }) => id === recipient).assignedMinutes, 210);

    const detailPath = `dashboard/tasks/${planned.id}/details`;
    const detail = await request(detailPath, 200);
    assert.equal(detail.reporter, 'Test recipient');
    assert.equal(detail.loggedMinutes, 60);
    assert.equal(detail.estimateMinutes, 90);
    assert.equal(detail.approval, 'Not required');
    assert.deepEqual(detail.subtasks, []);
    await request(`dashboard/tasks/${foreignTask}/details`, 404);
    await request(detailPath, 400, bodyOptions('PATCH', { approval: 'Unknown' }));
    const approved = await request(detailPath, 200, bodyOptions('PATCH', { approval: 'Pending' }));
    assert.equal(approved.approval, 'Pending');
    assert.equal((await request(detailPath, 200, bodyOptions('PATCH', { status: 'Blocked' }))).status, 'Blocked');
    await request(detailPath, 404, bodyOptions('PATCH', { assigneeId: foreignMember }));
    await request(detailPath, 404, bodyOptions('PATCH', { blockingTaskId: foreignTask }));
    await request(detailPath, 409, bodyOptions('PATCH', { blockingTaskId: planned.id }));
    assert.equal((await request(detailPath, 200, bodyOptions('PATCH', { blockingTaskId: discussedTask }))).blockingTaskId, discussedTask);
    await request(`dashboard/tasks/${discussedTask}/details`, 409, bodyOptions('PATCH', { blockingTaskId: planned.id }));
    const subtask = { title: 'Drawer child task', requestId: randomUUID() };
    const subtaskPath = `dashboard/tasks/${planned.id}/subtasks`;
    const createdSubtask = await request(subtaskPath, 201, bodyOptions('POST', subtask));
    assert.equal((await request(subtaskPath, 201, bodyOptions('POST', subtask))).id, createdSubtask.id);
    await request(subtaskPath, 409, bodyOptions('POST', { ...subtask, title: 'Different title' }));
    const attachmentPath = `dashboard/tasks/${planned.id}/attachment-links`;
    await request(attachmentPath, 400, bodyOptions('POST', { name: 'Invalid link', url: 'javascript:void(0)' }));
    const attachment = { name: 'Task brief', url: 'https://example.invalid/brief' };
    const savedAttachment = await request(attachmentPath, 201, bodyOptions('POST', attachment));
    assert.equal((await request(attachmentPath, 201, bodyOptions('POST', attachment))).id, savedAttachment.id);
    const filesPath = `dashboard/tasks/${planned.id}/attachments`;
    const content = new Uint8Array([37, 80, 68, 70, 10, 246]);
    const filePayload = (bytes = content) => {
      const data = new FormData();
      data.append('file', new Blob([bytes], { type: 'application/pdf' }), 'release-evidence.pdf');
      return { method: 'POST', body: data };
    };
    const uploaded = await request(filesPath, 201, filePayload());
    assert.deepEqual({ name: uploaded.name, sizeBytes: uploaded.sizeBytes }, { name: 'release-evidence.pdf', sizeBytes: content.length });
    assert.equal((await request(filesPath, 201, filePayload())).id, uploaded.id);
    await request(filesPath, 400, filePayload(new Uint8Array(0)));
    await request(filesPath, 413, filePayload(new Uint8Array(5 * 1024 * 1024 + 1)));
    await request(`dashboard/tasks/${foreignTask}/attachments`, 404, filePayload());
    const download = await fetch(`${api}/${filesPath}/${uploaded.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /attachment;.*release-evidence\.pdf/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), content);
    await request(`dashboard/tasks/${foreignTask}/attachments/${uploaded.id}`, 404);

    const refreshed = await request(detailPath, 200);
    assert.equal(refreshed.subtasks[0].id, createdSubtask.id);
    assert.deepEqual(refreshed.attachments, [savedAttachment, uploaded]);
    assert.ok(refreshed.activityCount > detail.activityCount);
    const label = randomUUID();
    await db.query("INSERT INTO labels (id, workspace_id, name) VALUES ($1, $2, 'Launch')", [label, workspace]);
    await db.query('INSERT INTO task_labels (task_id, label_id, workspace_id) VALUES ($1, $2, $3)', [planned.id, label, workspace]);
    await request(`dashboard/tasks/${createdSubtask.id}`, 200, bodyOptions('PATCH', { done: true }));
    const boardCards = await request(`dashboard/board-cards?projectId=${project}`, 200);
    assert.deepEqual(boardCards.find(({ id }) => id === planned.id),
      { id: planned.id, labels: ['Launch'], commentCount: 0, subtaskCount: 1, completedSubtasks: 1 });
    assert.equal(boardCards.find(({ id }) => id === discussedTask).commentCount, 1);
    assert.ok(!boardCards.some(({ id }) => id === foreignTask));
    await request(`dashboard/board-cards?projectId=${foreignProject}`, 404);

    await request(`dashboard/tasks/${discussedTask}`, 200, { method: 'DELETE' });
    assert.equal((await request(detailPath, 200)).blockingTaskId, null);

    const modalTask = { title: 'Created from board', projectId: project, status: 'Blocked', priority: 'Medium',
      assigneeId: recipient, dueDate: dates.next_week, requestId: randomUUID() };
    const createFromModal = () => request('dashboard/tasks', 201, bodyOptions('POST', modalTask));
    const [savedTask, duplicate] = await Promise.all([createFromModal(), createFromModal()]);
    assert.equal(savedTask.id, duplicate.id);
    assert.equal(savedTask.status, 'Blocked');
    assert.equal(savedTask.priority, 'Medium');
    assert.equal(savedTask.dueDate, dates.next_week);
    assert.equal(savedTask.assigneeId, recipient);
    assert.equal((await request('dashboard', 200)).tasks.filter(({ title }) => title === modalTask.title).length, 1);
    const activityAfterCreate = await request(`dashboard/tasks/${savedTask.id}/activity`, 200);
    assert.equal(activityAfterCreate.items.length, 1);
    await request('dashboard/tasks', 409, bodyOptions('POST', { ...modalTask, title: 'Different task' }));
    await request('dashboard/tasks', 404, bodyOptions('POST', { ...modalTask, projectId: foreignProject }));
    await request(`dashboard/tasks/${savedTask.id}/details`, 200, bodyOptions('PATCH', { status: 'In progress' }));
    assert.equal((await createFromModal()).status, 'In progress');

    const taskSchedule = { ...modalTask, title: 'Scheduled task', startDate: dates.today, requestId: randomUUID() };
    const scheduled = await request('dashboard/tasks', 201, bodyOptions('POST', taskSchedule));
    assert.equal(scheduled.startDate, dates.today);
    assert.ok(Number.isFinite(Date.parse(scheduled.createdAt)));
    assert.equal((await request('dashboard/tasks', 201, bodyOptions('POST', taskSchedule))).id, scheduled.id);
    await request('dashboard/tasks', 409, bodyOptions('POST', { ...taskSchedule, startDate: dates.next_week }));
    const taskPath = `dashboard/tasks/${scheduled.id}`;
    const { startDate: _startDate, ...legacyEdit } = taskSchedule;
    assert.equal((await request(taskPath, 200, bodyOptions('PATCH', legacyEdit))).startDate, dates.today);
    await request(taskPath, 400, bodyOptions('PATCH', { ...taskSchedule, startDate: '2026-02-30' }));
    await request(taskPath, 400, bodyOptions('PATCH', { ...taskSchedule, dueDate: '2000-01-01' }));
    await request(taskPath, 400, bodyOptions('PATCH', { ...legacyEdit, dueDate: '2000-01-01' }));
    await request(`${taskPath}/details`, 400, bodyOptions('PATCH', { dueDate: '2000-01-01' }));
    assert.equal((await request(`${taskPath}/details`, 200)).startDate, dates.today);
    await request(`${taskPath}/details`, 400, bodyOptions('PATCH', { startDate: '9999-12-31' }));
    const updatedSchedule = await request(`${taskPath}/details`, 200, bodyOptions('PATCH', { startDate: dates.next_week }));
    assert.equal(updatedSchedule.startDate, dates.next_week);
    const scheduleActivity = await request(`${taskPath}/activity`, 200);
    assert.ok(scheduleActivity.items.some(({ fields }) => fields.includes('Start date')));
    const { tasks: dashboardTasks } = await request('dashboard', 200);
    const reloaded = dashboardTasks.find(({ id }) => id === scheduled.id);
    assert.equal(reloaded.startDate, dates.next_week);
    assert.equal(Date.parse(reloaded.createdAt), Date.parse(scheduled.createdAt));
    assert.equal((await request(`${taskPath}/details`, 200, bodyOptions('PATCH', { startDate: null }))).startDate, null);

    const admin = 'dashboard/administration';
    const dept = await request(`${admin}/departments`, 201, bodyOptions('POST', { name: 'Engineering', leadId: recipient }));
    const engineering = dept.items.find(({ name }) => name === 'Engineering');
    assert.equal(engineering.leadId, recipient);
    await request(`${admin}/departments`, 409, bodyOptions('POST', { name: 'engineering' }));
    await request(`${admin}/departments`, 404, bodyOptions('POST', { name: 'Foreign lead', leadId: foreignMember }));
    const updatedDept = await request(`${admin}/departments/${engineering.id}`, 200, bodyOptions('PATCH', { name: 'Engineering', description: 'Software', leadId: recipient }));
    assert.equal(updatedDept.items.find(({ id }) => id === engineering.id).description, 'Software');
    const reporting = await request(`${admin}/reporting/${otherRecipient}`, 200, bodyOptions('PATCH', {
      managerId: recipient, departmentId: engineering.id, jobTitle: 'Developer',
    }));
    assert.equal(reporting.managers, 1);
    assert.equal(reporting.people.find(({ id }) => id === otherRecipient).managerId, recipient);
    await request(`${admin}/reporting/${recipient}`, 409, bodyOptions('PATCH', { managerId: otherRecipient }));
    await request(`${admin}/reporting/${recipient}`, 404, bodyOptions('PATCH', { managerId: foreignMember }));
    assert.equal((await request(`${admin}/departments`, 200)).items.find(({ id }) => id === engineering.id).capacityMinutes, 2400);
    const createdRole = await request(`${admin}/roles`, 201, bodyOptions('POST', { name: 'Test role', copyFrom: 'team-member' }));
    const roleKey = createdRole.selected;
    assert.deepEqual(createdRole.items.find(({ key }) => key === roleKey).permissions, ['Projects & tasks:View']);
    await request(`${admin}/roles/${roleKey}`, 200, bodyOptions('PATCH', { permission: 'Organization:View', enabled: true }));
    assert.equal((await request(`${admin}/roles`, 200)).items.find(({ key }) => key === roleKey).permissions.includes('Organization:View'), true);
    const filteredAudit = await request(`${admin}/audit?module=Roles&search=Test%20role&from=${dates.today}&to=${dates.today}`, 200);
    assert.deepEqual(filteredAudit.items.map(({ action }) => action), ['Granted', 'Duplicated']);
    await request(`${admin}/audit?from=${dates.next_week}&to=${dates.today}`, 400);

    const workbook = { fileName: 'Test workbook.xlsx', requestId: randomUUID(), rows: [
      { title: 'Workbook task', project: 'Test project', status: 'Blocked' },
      {},
      { title: 'Foreign workbook task', project: foreignProject },
    ] };
    const workbookPreview = await submitImport('dashboard/imports/preview', 201, workbook);
    assert.equal(workbookPreview.rows[0].projectId, project);
    assert.equal(workbookPreview.rows[1].skipped, true);
    assert.equal(workbookPreview.rows[2].error, 'Choose an existing workspace project.');
    await submitImport('dashboard/imports', 422, workbook);
    const workbookJob = await submitImport('dashboard/imports', 201, { ...workbook, allowPartial: true });
    assert.equal(workbookJob.taskCount, 1);
    assert.equal(workbookJob.skippedCount, 1);
    assert.equal(workbookJob.failedCount, 1);
    const replay = await submitImport('dashboard/imports', 201, { ...workbook, allowPartial: true });
    assert.equal(replay.id, workbookJob.id);
    const report = await fetch(`${api}/dashboard/imports/${workbookJob.id}/report`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /4,"Choose an existing workspace project."/);
    assert.equal((await request('dashboard/imports', 200)).items[0].fileName, 'Test workbook.xlsx');
    assert.equal((await request(`${admin}/audit?module=Import&search=Test%20workbook`, 200)).items[0].action, 'Imported');

    const auditDetailPath = `${admin}/audit`;
    const { items: savedTaskEvents } = await request(`${auditDetailPath}?module=Task&search=Created%20from%20board`, 200);
    const statusEvent = savedTaskEvents.find(({ fields }) => fields.includes('Status'));
    assert.deepEqual(await request(`${auditDetailPath}/${statusEvent.id}`, 200), {
      source: 'Flowdeck web application', previousValues: { Status: 'Blocked' }, updatedValues: { Status: 'In progress' },
    });
    const roleAudit = await request(`${auditDetailPath}/${filteredAudit.items[0].id}`, 200);
    assert.deepEqual(roleAudit.previousValues, { 'Organization:View': false });
    assert.deepEqual(roleAudit.updatedValues, { 'Organization:View': true });
    const { items: reportingEvents } = await request(`${auditDetailPath}?module=Organization&search=Manager`, 200);
    const reportingEvent = reportingEvents.find(({ fields }) => fields.includes('Manager'));
    assert.deepEqual((await request(`${auditDetailPath}/${reportingEvent.id}`, 200)).updatedValues,
      { Manager: 'Test recipient', Department: 'Engineering', 'Job title': 'Developer' });
    const imported = await request(`${auditDetailPath}/${workbookJob.id}`, 200);
    assert.deepEqual(imported.updatedValues, { Imported: 1, Failed: 1, Skipped: 1 });
    const { rows: [legacy] } = await db.query(
      "INSERT INTO task_activity (workspace_id, task_id, action, changed_fields, status_after) VALUES ($1, $2, 'updated', ARRAY['Status'], 'In review') RETURNING id",
      [workspace, savedTask.id],
    );
    assert.deepEqual(await request(`${auditDetailPath}/${legacy.id}`, 200), {
      source: 'Task activity', previousValues: null, updatedValues: { Status: 'In review' },
    });
    const { rows: [foreignEvent] } = await db.query('SELECT id FROM task_activity WHERE workspace_id = $1 LIMIT 1', [otherWorkspace]);
    await request(`${auditDetailPath}/${foreignEvent.id}`, 404);

    const directory = `${admin}/users`;
    const { roles: availableRoles } = await request(`${directory}/options`, 200);
    assert.ok(availableRoles.some(({ key }) => key === 'system-admin'));
    const baselineDirectory = await request(directory, 200);
    assert.equal(baselineDirectory.summary.active, 2);
    assert.equal(baselineDirectory.total, 2);

    const workEmail = `management-${randomUUID()}@example.invalid`;
    const profileInputs = { name: 'Directory Alpha', email: workEmail, status: 'inactive', departmentId: engineering.id,
      roleKey: 'project-manager', jobTitle: 'Engineering lead', managerId: recipient };
    const newUser = await request(directory, 201, bodyOptions('POST', profileInputs));
    createdUsers.push(newUser.id);
    assert.match(newUser.employeeId, /^[A-Z]+-\d+$/);
    assert.equal(newUser.department, 'Engineering');
    assert.equal(newUser.manager, 'Test recipient');
    assert.equal(newUser.roleLabel, 'Project Manager');
    await request(directory, 409, bodyOptions('POST', { ...profileInputs, email: workEmail.toUpperCase() }));

    const match = await request(`${directory}?search=${newUser.employeeId}&status=inactive&department=${engineering.id}`, 200);
    assert.deepEqual(match.items.map(({ id }) => id), [newUser.id]);
    assert.equal(match.summary.inactive, 1);
    assert.equal(match.summary.active, baselineDirectory.summary.active);
    await request(`${directory}/${foreignMember}`, 404);
    await request(`${directory}/${newUser.id}`, 404, bodyOptions('PATCH', { managerId: foreignMember }));
    await request(`${directory}/${newUser.id}`, 409, bodyOptions('PATCH', { managerId: newUser.id }));

    const contact = `workspace-${randomUUID()}@example.invalid`;
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [otherWorkspace, newUser.id]);
    const changedUser = await request(`${directory}/${newUser.id}`, 200,
      bodyOptions('PATCH', { name: 'Directory renamed', email: contact, status: 'active' }));
    assert.equal(changedUser.user.email, contact);
    assert.equal(changedUser.user.employeeId, newUser.employeeId);
    assert.equal(changedUser.user.status, 'active');
    const { rows: [unchanged] } = await db.query('SELECT name, email FROM workspace_people WHERE workspace_id = $1 AND user_id = $2', [otherWorkspace, newUser.id]);
    assert.deepEqual(unchanged, { name: profileInputs.name, email: workEmail });
    await request(`${directory}/${recipient}`, 403, bodyOptions('PATCH', { status: 'inactive' }));

    const managedTask = await request('dashboard/tasks', 201, bodyOptions('POST', { ...taskInput, title: 'Managed user task',
      status: 'Blocked', assigneeId: newUser.id, estimateMinutes: 105 }));
    assert.equal(managedTask.assignee, 'Directory renamed');
    const profile = await request(`${directory}/${newUser.id}`, 200);
    assert.equal(profile.workload.assignedMinutes, 105);
    assert.equal(profile.workload.blocked, 1);
    assert.equal(profile.projects[0].id, project);
    assert.equal(profile.projects[0].tasks, 1);

    for (let index = 0; index < 3; index++) {
      const invited = await request(directory, 201, bodyOptions('POST', { name: `Directory invite ${index}`,
        email: `invite-${randomUUID()}@example.invalid`, status: 'pending_invitation' }));
      createdUsers.push(invited.id);
    }
    const secondPage = await request(`${directory}?page=2&sort=name`, 200);
    assert.equal(secondPage.page, 2);
    assert.equal(secondPage.total, 6);
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.summary.pending_invitation, 3);
    const profileAudit = (await request(`${admin}/audit?module=User&search=Directory%20renamed`, 200)).items;
    assert.ok(profileAudit.some(item => item.action === 'Activated'));
    const contactAudit = profileAudit.find(item => item.fields.includes('Work email'));
    assert.deepEqual((await request(`${admin}/audit/${contactAudit.id}`, 200)).updatedValues, {
      'Full name': 'Directory renamed', 'Work email': contact,
    });

    await db.query("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2", [workspace, recipient]);
    await request(`${directory}/${newUser.id}`, 403, bodyOptions('PATCH', { roleKey: 'system-admin' }));
    await db.query("UPDATE workspace_members SET status = 'inactive' WHERE workspace_id = $1 AND user_id = $2", [workspace, recipient]);
    await request('dashboard', 403);
    await request('notifications', 403);
    await request('account/profile', 403);
    await updateOwnContact({ name: 'Inactive change' }, 403);

    console.log('Notifications, board, task activity, member detail, import, overview, administration, workspace panels, project overview, task details, create task, task scheduling, audit detail, user management, and my profile integration passed.');
  } finally {
    if (server && server.exitCode === null) server.kill();
    try {
      await db.query('DELETE FROM task_labels WHERE workspace_id = $1', [workspace]);
      await db.query('DELETE FROM labels WHERE workspace_id = $1', [workspace]);
      await db.query('DELETE FROM tasks WHERE workspace_id = ANY($1::uuid[])', [[workspace, otherWorkspace]]);
      await db.query('DELETE FROM project_members WHERE workspace_id = $1', [workspace]);
      await db.query('DELETE FROM projects WHERE workspace_id = ANY($1::uuid[])', [[workspace, otherWorkspace]]);
      await db.query('DELETE FROM workspace_members WHERE workspace_id = ANY($1::uuid[])', [[workspace, otherWorkspace]]);
      await db.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[workspace, otherWorkspace]]);
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[recipient, otherRecipient, foreignMember, ...createdUsers]]);
    } finally {
      await db.end();
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
