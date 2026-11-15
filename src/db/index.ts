import pg from 'pg';
import { mkdirSync } from 'node:fs';

/**
 * Minimal database interface shared by node-postgres (production) and PGlite
 * (embedded Postgres for local dev + tests). All application SQL is plain Postgres.
 */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** Run fn inside a transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly kind: 'pg' | 'pglite';
}

export interface Tx extends Queryable {
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

// node-postgres returns int8/numeric as strings; we cast counts in SQL but normalise int8 anyway.
pg.types.setTypeParser(20, (v) => Number(v));

function wrapTx(q: Queryable): Tx {
  const tx: Tx = {
    query: (sql, params) => q.query(sql, params),
    tx: (fn) => fn(tx),
  };
  return tx;
}

export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('pglite')) return createPglite(url);
  return createPg(url);
}

async function createPg(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', () => {
    /* idle client errors are surfaced on next query */
  });
  return {
    kind: 'pg',
    async query(sql, params) {
      const r = await pool.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(
          wrapTx({
            query: async (sql, params) => {
              const r = await client.query(sql, params as any[]);
              return { rows: r.rows, rowCount: r.rowCount ?? 0 };
            },
          }),
        );
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPglite(url: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const location = url.replace(/^pglite:?/, '');
  let db: InstanceType<typeof PGlite>;
  if (!location || location === 'memory') {
    db = new PGlite();
  } else {
    mkdirSync(location, { recursive: true });
    db = new PGlite(location);
  }
  await db.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params) {
      const r = await db.query(sql, params as any[]);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
    async tx(fn) {
      return db.transaction(async (t) =>
        fn(
          wrapTx({
            query: async (sql, params) => {
              const r = await t.query(sql, params as any[]);
              return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
            },
          }),
        ),
      );
    },
    async exec(sql) {
      try {
        await db.exec(sql);
      } catch (err) {
        await db.exec('ROLLBACK').catch(() => {});
        throw err;
      }
    },
    async close() {
      await db.close();
    },
  };
}

export async function one<T>(q: Queryable, sql: string, params?: unknown[]): Promise<T | undefined> {
  const r = await q.query<T>(sql, params);
  return r.rows[0];
}
