import { createSql } from './client.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const sql = createSql(url, { max: 1, application: 'autodeploy-migrate' });
try {
  const r = await migrate(sql, undefined, (m) => console.log(m));
  console.log(`migrations: ${r.applied.length} applied, ${r.skipped} already up to date`);
} finally {
  await sql.end();
}
