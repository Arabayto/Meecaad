// Applies the schema automatically on the first request, so a new deployment
// works without running any command (e.g. when set up from a phone through
// the Cloudflare dashboard). Uses wrangler's own `d1_migrations` table, so
// `wrangler d1 migrations apply` and this stay in agreement.
//
// New migrations: add the file in migrations/ AND to the list below.
import m0001 from '../migrations/0001_init.sql';

const MIGRATIONS: [string, string][] = [['0001_init.sql', m0001]];

let checked = false;

/** Splits a migration into statements (triggers are written on one line). */
function statements(sql: string) {
  return sql
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(/;\s*\n/).map((s) => s.trim().replace(/;$/, '')).filter(Boolean);
}

export async function ensureSchema(db: D1Database) {
  if (checked) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run();
  const done = new Set((await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    try {
      // One batch = one transaction: the migration and its record are saved together.
      await db.batch([...statements(sql).map((s) => db.prepare(s)), db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name)]);
    } catch (err) {
      // Another request may have applied it at the same moment.
      const again = await db.prepare('SELECT 1 FROM d1_migrations WHERE name = ?').bind(name).first();
      if (!again) throw err;
    }
  }
  checked = true;
}
