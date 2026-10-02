/**
 * Fixed-window rate limiter.
 *
 * Store: in-memory by default; set RATE_LIMIT_STORE=redis to share counters
 * across instances (falls back to memory if Redis errors, so a Redis outage
 * degrades to per-process limits instead of disabling the limiter).
 */
const memory = new Map();

const memoryIncr = (key, windowMs) => {
  const now = Date.now();
  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    memory.set(key, entry);
  }
  entry.count += 1;
  return { count: entry.count, retryAfterMs: entry.resetAt - now };
};

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
}, 60_000);
sweeper.unref();

const redisIncr = async (key, windowMs) => {
  const redis = require('../db/redis');
  const k = `rl:${key}`;
  const [[, count], [, ttl]] = await redis.multi().incr(k).pttl(k).exec();
  if (ttl < 0) await redis.pexpire(k, windowMs);
  return { count, retryAfterMs: ttl < 0 ? windowMs : ttl };
};

const incr = async (key, windowMs) => {
  if (process.env.RATE_LIMIT_STORE === 'redis') {
    try { return await redisIncr(key, windowMs); } catch (err) {
      console.error('[RateLimit] Redis store failed, using memory:', err.message);
    }
  }
  return memoryIncr(key, windowMs);
};

const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * @param {object} opts
 * @param {string} opts.name        counter namespace
 * @param {number} opts.windowMs
 * @param {number} opts.max         requests allowed per window per key
 * @param {(req)=>string|null} [opts.keyFn] defaults to client IP; return null to skip
 */
const rateLimit = ({ name, windowMs, max, keyFn = clientIp }) => async (req, res, next) => {
  try {
    const id = keyFn(req);
    if (!id) return next();
    const { count, retryAfterMs } = await incr(`${name}:${id}`, windowMs);
    if (count > max) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** Key helper: limit per (normalised) email from the request body. */
const emailKey = (req) => {
  const e = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return e ? e.slice(0, 254) : null;
};

const _resetForTests = () => memory.clear();

module.exports = { rateLimit, emailKey, clientIp, _resetForTests };
