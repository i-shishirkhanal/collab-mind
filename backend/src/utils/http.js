const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Error carrying an HTTP status, picked up by the global Express error handler. */
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Router-level guard: rejects malformed UUID params before they reach Postgres. */
const requireUuidParams = (...names) => (req, _res, next) => {
  for (const name of names) {
    if (!isUuid(req.params[name])) return next(httpError(400, `Invalid ${name}`));
  }
  next();
};

/** Escapes LIKE/ILIKE wildcards in user-supplied search text. */
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

module.exports = { isUuid, httpError, requireUuidParams, escapeLike };
