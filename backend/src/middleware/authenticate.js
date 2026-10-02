const { verifySessionToken } = require('../services/sessionService');

/**
 * authenticate
 * ────────────
 * Requires `Authorization: Bearer <session token>`. The token's signature,
 * algorithm, issuer, audience and expiry are verified, and the session must
 * still be live in the database (so logout/password reset take effect at once).
 * There is no demo or fallback identity: every failure is a 401.
 *
 * Sets req.user = { id, email, name, sessionId }.
 */
const authenticate = async (req, res, next) => {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or malformed', code: 'INVALID_TOKEN' });
  }

  try {
    const user = await verifySessionToken(header.slice(7).trim());
    req.user = { id: user.id, email: user.email, name: user.name, sessionId: user.sessionId };
    return next();
  } catch (err) {
    if (err.status === 401) return res.status(401).json({ error: err.message, code: err.code });
    return next(err); // database failure etc. -> 500 via the error handler
  }
};

module.exports = authenticate;
