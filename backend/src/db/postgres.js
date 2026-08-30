const { Pool } = require('pg');

/**
 * Shared PostgreSQL connection pool.
 * All queries across the app should use this pool instance,
 * which manages connection lifecycle automatically.
 *
 * Connection settings are derived from the DATABASE_URL environment variable:
 *   postgresql://user:password@host:port/dbname
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep at most 10 open connections; idle connections closed after 30 s
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Log pool-level errors (e.g. dropped connections) without crashing
pool.on('error', (err) => {
  console.error('[PG] Unexpected pool error:', err.message);
});

// Verify connectivity at startup (optional but useful early-failure signal)
pool.connect()
  .then((client) => {
    console.log('✅  PostgreSQL pool connected');
    client.release();
  })
  .catch((err) => {
    console.error('❌  PostgreSQL pool connection failed:', err.message);
  });

module.exports = pool;
