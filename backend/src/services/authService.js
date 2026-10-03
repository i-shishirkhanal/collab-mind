const { v4: uuidv4 } = require('uuid');
const pool = require('../db/postgres');
const { hashPassword, verifyPassword, verifyAgainstDummy, passwordPolicyError } = require('../utils/passwords');
const { issueSession, revokeAllSessions, randomToken, hashToken } = require('./sessionService');
const mailer = require('./mailer');
const { httpError } = require('../utils/http');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Trim + lowercase + NFKC. Returns null when it is not a plausible address. */
const normalizeEmail = (value) => {
  if (typeof value !== 'string') return null;
  const email = value.normalize('NFKC').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
};

const normalizeName = (value, email) => {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  return name || email.split('@')[0].slice(0, 100);
};

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url ?? null });

/** Replaces any outstanding token of this purpose and mails a fresh one. */
const createAndSendToken = async (client, user, purpose) => {
  const token = randomToken();
  const ttl = purpose === 'verify_email' ? VERIFY_TTL_MS : RESET_TTL_MS;
  await client.query(`DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [user.id, purpose]);
  await client.query(
    `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [uuidv4(), user.id, purpose, hashToken(token), new Date(Date.now() + ttl)],
  );
  return token;
};

const sendQuietly = async (fn, what) => {
  try { await fn(); } catch (err) {
    // Never surface mail failures to the caller: that would reveal whether the address exists.
    console.error(`[Auth] Failed to send ${what} email: ${err.message}`);
  }
};

/**
 * register — creates an UNVERIFIED account (or refreshes an unverified one) and
 * emails a verification link. Always resolves the same way whether or not the
 * address is already registered (no account enumeration). A verified account is
 * never modified by a registration attempt.
 */
const register = async ({ email: rawEmail, password, name: rawName }) => {
  const email = normalizeEmail(rawEmail);
  if (!email) throw httpError(400, 'A valid email address is required');
  const policyError = passwordPolicyError(password, email);
  if (policyError) throw httpError(400, policyError);
  const name = normalizeName(rawName, email);

  const passwordHash = await hashPassword(password); // always hash: equalises timing

  // Test deployments only: skip the verification mail and mark the account verified at sign-up.
  const autoVerify = process.env.AUTO_VERIFY_EMAIL === 'true';

  let user;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (email) DO UPDATE
              SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
                  email_verified_at = EXCLUDED.email_verified_at, updated_at = NOW()
            WHERE users.email_verified_at IS NULL
        RETURNING id, email, name`,
      [uuidv4(), email, name, passwordHash, autoVerify ? new Date() : null],
    );
    user = rows[0];
    if (user) await revokeAllSessions(user.id); // refreshing an unverified account kills any old sessions
  } catch (err) {
    if (err.code !== '23505') throw err; // case-variant duplicate etc.: treat as "already registered"
  }

  if (user && !autoVerify) {
    const token = await createAndSendToken(pool, user, 'verify_email');
    await sendQuietly(() => mailer.sendVerificationEmail(user.email, token), 'verification');
  }
};

const consumeToken = async (client, token, purpose) => {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const { rows } = await client.query(
    `UPDATE auth_tokens SET used_at = NOW()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()
  RETURNING user_id`,
    [hashToken(token), purpose],
  );
  return rows[0]?.user_id ?? null;
};

const inTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
};

const invalidToken = () => Object.assign(httpError(400, 'This link is invalid or has expired'), { code: 'INVALID_TOKEN' });

const verifyEmail = (token) => inTransaction(async (client) => {
  const userId = await consumeToken(client, token, 'verify_email');
  if (!userId) throw invalidToken();
  await client.query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1`,
    [userId],
  );
});

const resendVerification = async (rawEmail) => {
  const email = normalizeEmail(rawEmail);
  if (!email) return;
  const { rows } = await pool.query(
    `SELECT id, email FROM users WHERE email = $1 AND email_verified_at IS NULL AND password_hash IS NOT NULL`,
    [email],
  );
  if (!rows[0]) return;
  const token = await createAndSendToken(pool, rows[0], 'verify_email');
  await sendQuietly(() => mailer.sendVerificationEmail(rows[0].email, token), 'verification');
};

/**
 * login — verifies the password, requires a verified email, issues a session.
 * Wrong email and wrong password are indistinguishable (message and timing).
 */
const login = async ({ email: rawEmail, password }, meta = {}) => {
  const email = normalizeEmail(rawEmail);
  const invalid = () => Object.assign(httpError(401, 'Invalid email or password'), { code: 'INVALID_CREDENTIALS' });
  if (!email || typeof password !== 'string' || password.length === 0 || password.length > 128) {
    if (typeof password === 'string') await verifyAgainstDummy(password.slice(0, 128));
    throw invalid();
  }

  const { rows } = await pool.query(
    `SELECT id, email, name, avatar_url, password_hash, email_verified_at FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];
  const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : await verifyAgainstDummy(password);
  if (!user || !ok) throw invalid();

  if (!user.email_verified_at) {
    throw Object.assign(httpError(403, 'Please verify your email address before signing in'), { code: 'EMAIL_NOT_VERIFIED' });
  }

  const session = await issueSession(user, meta);
  return { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) };
};

const requestPasswordReset = async (rawEmail) => {
  const email = normalizeEmail(rawEmail);
  if (!email) return;
  const { rows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [email]);
  if (!rows[0]) return;
  const token = await createAndSendToken(pool, rows[0], 'reset_password');
  await sendQuietly(() => mailer.sendPasswordResetEmail(rows[0].email, token), 'password reset');
};

/** Completing a reset proves mailbox ownership, so it also verifies the email. */
const resetPassword = async (token, newPassword) => {
  // Reject a weak password before the single-use token is consumed.
  const early = passwordPolicyError(newPassword);
  if (early) throw httpError(400, early);
  const hash = await hashPassword(newPassword);
  return inTransaction(async (client) => {
    const userId = await consumeToken(client, token, 'reset_password');
    if (!userId) throw invalidToken();
    const { rows } = await client.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const policyError = passwordPolicyError(newPassword, rows[0]?.email);
    if (policyError || !hash) throw httpError(400, policyError || 'Invalid password');
    await client.query(
      `UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [userId, hash],
    );
    await client.query(`DELETE FROM auth_tokens WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await revokeAllSessions(userId, client);
  });
};

const getUserById = async (id) => {
  const { rows } = await pool.query(`SELECT id, email, name, avatar_url FROM users WHERE id = $1`, [id]);
  return rows[0] ? publicUser(rows[0]) : null;
};

module.exports = {
  normalizeEmail, register, verifyEmail, resendVerification, login,
  requestPasswordReset, resetPassword, getUserById,
};
