// Pull sprints and issues from Jira into PostgreSQL.  Usage: npm run sync
import 'dotenv/config';
import { syncFromJira } from '../src/jira/sync.js';
import { pool } from '../src/config/db.js';

try {
  await syncFromJira();
} catch (err) {
  console.error(`Sync failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
