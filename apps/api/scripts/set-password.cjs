const { Pool } = require('pg');
const { hashPassword } = require('../dist/auth/password-hash');

async function main() {
  const email = process.argv[2]?.trim();
  const workspaceId = process.env.PASSWORD_AUTH_WORKSPACE_ID || process.env.LOCAL_DASHBOARD_WORKSPACE_ID;
  if (!email || !workspaceId || !process.env.DATABASE_URL || process.stdin.isTTY) {
    throw new Error('Provide a work email, a workspace ID and a password through standard input.');
  }

  process.stdin.setEncoding('utf8');
  let password = '';
  for await (const chunk of process.stdin) {
    password += chunk;
    if (password.length > 130) throw new Error('Use a password of 8–128 characters.');
  }
  password = password.replace(/\r?\n$/, '');
  if (password.length < 8 || password.length > 128) throw new Error('Use a password of 8–128 characters.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const account = await pool.query(
      `SELECT u.id FROM users u JOIN workspace_members m ON m.user_id = u.id
       WHERE lower(u.email) = lower($1) AND m.workspace_id = $2 AND m.status = 'active'`,
      [email, workspaceId],
    );
    if (account.rows.length !== 1) throw new Error('No unique active account matches that email in this workspace.');
    const { id } = account.rows[0];
    const hash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO user_passwords (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [id, hash],
      );
      await client.query('DELETE FROM password_sessions WHERE user_id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    console.log('Password saved. Existing password sessions were revoked.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
