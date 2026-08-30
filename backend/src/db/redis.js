const Redis = require('ioredis');

/**
 * Shared Redis client.
 * Used throughout the app for caching, session data, or pub/sub.
 *
 * Connection is configured via the REDIS_URL environment variable:
 *   redis://[:password@]host[:port][/db-number]
 */
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // Automatically reconnect with exponential back-off (max 10 s)
  retryStrategy: (times) => Math.min(times * 200, 10_000),
  // Do not crash the process on connect failures; surface via 'error' event
  lazyConnect: false,
  enableOfflineQueue: true,
});

redis.on('connect', () => {
  console.log('✅  Redis client connected');
});

redis.on('error', (err) => {
  console.error('[REDIS] Client error:', err.message);
});

redis.on('reconnecting', (ms) => {
  console.warn(`[REDIS] Reconnecting in ${ms}ms…`);
});

module.exports = redis;
