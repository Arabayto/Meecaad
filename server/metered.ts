// Counts the database rows each request reads (what Cloudflare D1 bills on).
// The total is sent back in the X-Rows-Read header, and unusually heavy
// requests are logged, so expensive screens can be spotted and fixed.

export function metered(db: D1Database) {
  let rows = 0;
  const add = (meta: any) => { rows += Number(meta?.rows_read ?? 0); };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const w: any = {
      bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
      all: async () => { const r = await stmt.all(); add(r.meta); return r; },
      run: async () => { const r = await stmt.run(); add(r.meta); return r; },
      first: async (col?: string) => {
        const r = await stmt.all<any>(); add(r.meta);
        const row = r.results[0] ?? null;
        return col && row ? row[col] ?? null : row;
      },
      raw: (o?: any) => stmt.raw(o),
      inner: stmt,
    };
    return w as D1PreparedStatement;
  };
  const wrapped: any = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: any[]) => {
      const r = await db.batch(stmts.map((s) => s.inner ?? s));
      for (const x of r) add(x.meta);
      return r;
    },
    exec: (sql: string) => db.exec(sql),
    dump: () => (db as any).dump(),
  };
  return { db: wrapped as D1Database, rows: () => rows };
}
