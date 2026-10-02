/**
 * Terminal Express handlers. 4xx errors thrown with a status keep their message
 * (they are written for clients); anything else is logged server-side and
 * returned as a generic 500 so internals (SQL, stack traces, hosts) never leak.
 */
const notFound = (_req, res) => res.status(404).json({ error: 'Route not found' });

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
    return res.status(status).json({ error: 'Internal server error' });
  }
  const payload = { error: err.message || 'Request failed' };
  if (err.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) payload.code = err.code;
  return res.status(status).json(payload);
};

module.exports = { notFound, errorHandler };
