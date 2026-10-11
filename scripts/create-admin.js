// Create (or reset) an administrator who can sign in.  Usage: npm run create-admin
// If the name matches a person already synced from Jira, the sign-in is added to that person.
import 'dotenv/config';
import readline from 'node:readline';
import { pool, query } from '../src/config/db.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

// Read a line without echoing it (for passwords): readline keeps the terminal in raw mode, we just
// stop it from writing the typed characters back to the screen.
let muted = false;
rl._writeToOutput = (text) => {
  if (!muted) rl.output.write(text);
};
function askHidden(q) {
  if (!process.stdin.isTTY) throw new Error('Run this in a terminal so the password is not shown');
  return new Promise((resolve) => {
    rl.question(q, (a) => {
      muted = false;
      process.stdout.write('\n');
      resolve(a);
    });
    muted = true; // after the prompt is drawn
  });
}

try {
  console.log('Create an AgileMetrix administrator\n');
  const name = await ask('Full name: ');
  const username = await ask('Username: ');
  if (!name || !/^[a-zA-Z0-9._-]{3,60}$/.test(username)) throw new Error('A name and a username of 3–60 letters, numbers, dots, dashes or underscores are required');
  const password = await askHidden(`Password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if ((await askHidden('Repeat password: ')) !== password) throw new Error('The passwords do not match');

  const { rows: roles } = await query("SELECT id FROM roles WHERE name = 'Administrator'");
  if (!roles[0]) throw new Error('The Administrator role is missing (run schema/003_admin.sql)');
  const hash = await hashPassword(password);

  // Reuse: same username, otherwise the same name (e.g. synced from Jira), otherwise a new person
  const { rows: found } = await query(
    `SELECT id, name FROM users WHERE lower(username) = lower($1)
     UNION ALL SELECT id, name FROM users WHERE username IS NULL AND lower(name) = lower($2) LIMIT 1`,
    [username, name]
  );
  let id = found[0]?.id;
  if (id) {
    await query(`UPDATE users SET username = $2, password_hash = $3, role_id = $4, status = 'active' WHERE id = $1`, [id, username, hash, roles[0].id]);
  } else {
    ({ rows: [{ id }] } = await query(
      `INSERT INTO users (name, username, password_hash, role_id, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [name, username, hash, roles[0].id]
    ));
  }
  await query('DELETE FROM sessions WHERE user_id = $1', [id]);
  console.log(`\n✓ ${found[0] ? `Updated ${found[0].name}` : `Created ${name}`}: Administrator, username "${username}". Sign in at http://localhost:5173`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
