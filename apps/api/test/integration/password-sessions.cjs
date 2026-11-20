const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { hashPassword } = require('../../dist/auth/password-hash');

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'Load the local API environment.');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname), 'Test requires local PostgreSQL.');

async function run() {
  const db = new Client({ connectionString: databaseUrl });
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const email = `${userId}@example.invalid`;
  const password = randomUUID();
  const newPassword = randomUUID();
  const origin = 'http://localhost:5173';
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  let server;
  await db.connect();
  try {
    await db.query('INSERT INTO workspaces(id, name) VALUES ($1, $2)', [workspaceId, 'Password session test']);
    await db.query('INSERT INTO users(id, display_name, email) VALUES ($1, $2, $3)', [userId, 'Session test user', email]);
    await db.query("INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ($1, $2, 'member')", [workspaceId, userId]);
    await db.query('INSERT INTO user_passwords(user_id, password_hash) VALUES ($1, $2)', [userId, await hashPassword(password)]);
    server = spawn(process.execPath, ['dist/main.js'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env, PORT: String(port), WEB_ORIGIN: origin, NODE_ENV: 'test',
        DATABASE_AUTH_ENABLED: 'true', PASSWORD_AUTH_WORKSPACE_ID: workspaceId,
        LOCAL_DASHBOARD_WORKSPACE_ID: workspaceId, LOCAL_DASHBOARD_USER_ID: userId,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const api = `http://127.0.0.1:${port}/api`;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(`${api}/health`).then((result) => result.ok, () => false)) break;
      await delay(100);
    }
    async function request(route, expected, { method = 'GET', body, cookie, requestOrigin = origin } = {}) {
      const headers = { Origin: requestOrigin };
      if (body) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const response = await fetch(`${api}/${route}`, { method, headers, body: body && JSON.stringify(body) });
      assert.equal(response.status, expected, `${method} ${route}`);
      return response;
    }

    await request('dashboard', 401);
    const signIn = (credential, expected = 204) => request('session/login', expected, {
      method: 'POST', body: { email, password: credential },
    });
    const login = await signIn(password);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';')[0];
    const otherSession = (await signIn(password)).headers.get('set-cookie').split(';')[0];
    const dashboard = await request('dashboard', 200, { cookie });
    assert.equal((await dashboard.json()).userId, userId);
    await request('account/profile', 200, { cookie });
    await request('dashboard/projects', 403, { method: 'POST', cookie, body: { name: 'Restricted' } });
    const task = `dashboard/tasks/${randomUUID()}`;
    const complete = { method: 'PATCH', cookie, body: { done: true } };
    await request(task, 403, complete);
    await db.query("UPDATE workspace_members SET role = 'team lead' WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
    await request(task, 404, complete);
    await request('dashboard/administration/users', 403, { cookie });

    const change = (currentPassword, expected, requestOrigin) => request('session/password', expected, {
      method: 'PATCH', cookie, requestOrigin,
      body: { currentPassword, newPassword, confirmPassword: newPassword },
    });
    await change(password, 403, 'http://other.example.invalid');
    await change('invalid password', 400);
    await change(password, 204);
    await request('dashboard', 401, { cookie });
    await request('dashboard', 401, { cookie: otherSession });
    await signIn(password, 401);

    const freshCookie = (await signIn(newPassword)).headers.get('set-cookie').split(';')[0];
    await request('dashboard', 200, { cookie: freshCookie });
    await request('session/logout', 204, { method: 'POST', cookie: freshCookie });
    await request('dashboard', 401, { cookie: freshCookie });
    console.log('Password login, workspace access, password changes and session revocation passed.');
  } finally {
    server?.kill();
    try {
      await db.query('DELETE FROM user_passwords WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
      await db.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    } finally {
      await db.end();
    }
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
