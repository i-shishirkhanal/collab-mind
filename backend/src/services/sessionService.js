const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/postgres');
const { jwtSecret, sessionTtlSeconds, JWT_ISSUER, JWT_AUDIENCE } = require('../config/env');
const { isUuid } = require('../utils/http');

/**
 * Sessions are signed JWTs (HS256, iss/aud/sub/exp/jti) that are ALSO backed by
 * a row in auth_sessions, so logout, password reset and account changes revoke
 * access immediately instead of waiting for the token to expire.
 */

const issueSession = async (user, { userAgent = null, ip = null } = {}) => {
  const sid = uuidv4();
  const ttl = sessionTtlSeconds();
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, expires_at, user_agent, ip)
          VALUES ($1, $2, $3, $4, $5)`,
    [sid, user.id, expiresAt, userAgent && String(userAgent).slice(0, 255), ip],
  );

  const token = jwt.sign({}, jwtSecret(), {
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: user.id,
    jwtid: sid,
    expiresIn: ttl,
  });
  return { token, sessionId: sid, expiresAt };
};

/**
 * Verifies signature, algorithm, issuer, audience, expiry, then confirms the
 * session is live and the account is still verified.
 * @returns {Promise<{id,email,name,sessionId,expiresAt}>}
 * @throws Error with .status 401 and .code 'TOKEN_EXPIRED' | 'INVALID_TOKEN'
 */
const verifySessionToken = async (token) => {
  const fail = (code, message) => Object.assign(new Error(message), { status: 401, code });
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    throw fail('INVALID_TOKEN', 'Invalid token');
  }

  let claims;
  try {
    claims = jwt.verify(token, jwtSecret(), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      clockTolerance: 5,
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw fail('TOKEN_EXPIRED', 'Token has expired');
    throw fail('INVALID_TOKEN', 'Invalid token');
  }

  if (!isUuid(claims.sub) || !isUuid(claims.jti)) throw fail('INVALID_TOKEN', 'Invalid token');

  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, s.id AS session_id, s.expires_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2
        AND s.revoked_at IS NULL AND s.expires_at > NOW()
        AND u.email_verified_at IS NOT NULL`,
    [claims.jti, claims.sub],
  );
  if (rows.length === 0) throw fail('INVALID_TOKEN', 'Invalid token');

  const r = rows[0];
  return { id: r.id, email: r.email, name: r.name, sessionId: r.session_id, expiresAt: r.expires_at };
};

const revokeSession = async (sessionId, userId) => {
  await pool.query(
    `UPDATE auth_sessions SET revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId],
  );
};

/** Revokes every live session (optionally keeping one) and returns the revoked session ids. */
const revokeAllSessions = async (userId, client = pool, exceptSessionId = null) => {
  const { rows } = await client.query(
    `UPDATE auth_sessions SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)
  RETURNING id`,
    [userId, exceptSessionId],
  );
  return rows.map((r) => r.id);
};

const purgeExpired = async () => {
  await pool.query(`DELETE FROM auth_sessions WHERE expires_at < NOW() - INTERVAL '7 days'`);
  await pool.query(`DELETE FROM auth_tokens WHERE expires_at < NOW() - INTERVAL '7 days' OR used_at < NOW() - INTERVAL '7 days'`);
};

const randomToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = {
  issueSession, verifySessionToken, revokeSession, revokeAllSessions, purgeExpired, randomToken, hashToken,
};
