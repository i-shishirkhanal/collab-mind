const crypto = require('node:crypto');

/**
 * Assigns every request an id (echoed in the X-Request-Id response header, and in server error logs) and,
 * in production, writes one JSON access-log line per request. Query strings are never logged (they can
 * carry tokens). A client-supplied X-Request-Id is only honoured when it is short and plain.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

const requestLog = ({ json = process.env.NODE_ENV === 'production', write = (line) => process.stdout.write(`${line}\n`) } = {}) =>
  (req, res, next) => {
    const supplied = req.get('x-request-id');
    req.id = supplied && SAFE_ID.test(supplied) ? supplied : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    if (!json) return next();

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      write(JSON.stringify({
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : 'info',
        msg: 'request',
        id: req.id,
        method: req.method,
        path: (req.originalUrl || req.url).split('?')[0],
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        user: req.user && req.user.id,
        ip: req.ip,
      }));
    });
    return next();
  };

module.exports = { requestLog, SAFE_ID };
