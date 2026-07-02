import pg from "pg";

const { Pool } = pg;

let cachedPool = globalThis._postgresPool || null;

function getPoolConfig() {
  const connectionString = process.env.PG_URI || process.env.DATABASE_URL;

  if (connectionString) {
    return { connectionString };
  }

  const hasPgEnv =
    process.env.PGHOST ||
    process.env.PGDATABASE ||
    process.env.PGUSER ||
    process.env.PGPASSWORD ||
    process.env.PGPORT;

  if (hasPgEnv) {
    return {};
  }

  throw new Error("Postgres is not configured. Set PG_URI or DATABASE_URL.");
}

export function getPostgresPool() {
  if (!cachedPool) {
    cachedPool = new Pool(getPoolConfig());
    globalThis._postgresPool = cachedPool;
  }

  return cachedPool;
}

export function query(text, params) {
  return getPostgresPool().query(text, params);
}
