# FixMyBuddy backend setup

This backend was imported from the existing [FixMyBuddy backend](https://github.com/Nicko-Reorizo/FixMyBuddy/tree/main/backend). Run these commands from the root of `Fix-My-Buddy-Backend` with Node.js 24 and npm.

## Install and migrate

```powershell
npm ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

In the local `.env`, replace the entire `DATABASE_URL` with the connection string for a dedicated development PostgreSQL database or Supabase project. If you use `DIRECT_URL`, point it at the same development database. The migration prefers `DIRECT_URL`, and the app pool uses `DATABASE_URL`. Shell environment variables take precedence over `.env`, so check both before migrating. Keep `.env` and credentials local.

For the API, set `FRONTEND_ORIGIN` to the frontend's local origin and choose development values for `SESSION_SECRET` and `PASSWORD_PEPPER`. `PORT` defaults to `4000`. `REDIS_URL` is optional for a single local API instance.

```powershell
npm run db:migrate
```

The migration applies `sql/schema.sql` and requires a role that can create its tables and enable `pgcrypto`. Existing accounts and bookings stay in the old database. Run only the migration for schema setup.

## Verify the database

Use the application pool to run `SELECT 1` and check that every table declared in `sql/schema.sql` exists in the current schema. This works before the feature routes land.

```powershell
@'
import { readFile } from 'node:fs/promises';
import { getPool } from './src/db/pool.js';

const ddl = await readFile('sql/schema.sql', 'utf8');
const expected = [...ddl.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gim)].map(match => match[1]);
const pool = await getPool();
try {
  const { rows: connection } = await pool.query('SELECT 1 AS ok');
  const { rows: tables } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  `);
  const present = new Set(tables.map(row => row.table_name));
  const missing = expected.filter(name => !present.has(name));
  if (connection[0]?.ok !== 1 || expected.length === 0 || missing.length > 0) {
    throw new Error(`Database verification failed. Missing tables: ${missing.join(', ') || 'none'}`);
  }
  console.log(`SELECT 1 passed. Found all ${expected.length} FixMyBuddy tables.`);
} finally {
  await pool.end();
}
'@ | node --input-type=module
```

Once the auth, customer, provider, mechanic, and tracking PRs are merged, run `npm start`. In another terminal, run `curl.exe --fail http://localhost:4000/api/health` using your configured port. Expect HTTP 200 with `{"status":"ok","database":"connected"}`.
