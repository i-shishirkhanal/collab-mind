const { OAuth2Client } = require('google-auth-library');
const jwt  = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/postgres');

// Singleton Google OAuth2 client — reused across requests
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * verifyGoogleToken
 * ──────────────────
 * Validates a Google ID token sent from the client (obtained after the
 * user completes Google Sign-In on the frontend).
 *
 * @param {string} idToken - Raw Google ID token string
 * @returns {Promise<Object>} Verified token payload (sub, email, name, picture)
 * @throws {Error} If token is invalid or audience doesn't match
 */
const verifyGoogleToken = async (idToken) => {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload) {
    throw Object.assign(new Error('Google token payload is empty'), { status: 401 });
  }

  return payload; // { sub, email, name, picture, email_verified, ... }
};

/**
 * findOrCreateUser
 * ─────────────────
 * Looks up a user by google_id (the `sub` field). If the user doesn't exist,
 * creates a new row in the `users` table. Either way, returns the user record
 * and a signed JWT.
 *
 * @param {Object} googlePayload - Verified token payload from verifyGoogleToken
 * @returns {Promise<{ token: string, user: Object }>}
 */
const findOrCreateUser = async (googlePayload) => {
  const { sub: googleId, email, name, picture } = googlePayload;

  // Upsert: insert on first sign-in, update name/avatar on subsequent sign-ins
  const { rows } = await pool.query(
    `INSERT INTO users (id, google_id, email, name, avatar_url, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (google_id) DO UPDATE
            SET name       = EXCLUDED.name,
                avatar_url = EXCLUDED.avatar_url,
                updated_at = NOW()
      RETURNING id, google_id, email, name, avatar_url, created_at`,
    [uuidv4(), googleId, email, name, picture],
  );

  const user = rows[0];

  // Sign a JWT containing the minimal payload needed by the API
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  );

  return { token, user };
};

const findOrCreateEmailUser = async (email, nameInput) => {
  const name = nameInput || email.split('@')[0];
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, name, created_at)
          VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email) DO UPDATE
            SET name = COALESCE(EXCLUDED.name, users.name)
      RETURNING id, email, name, avatar_url, created_at`,
    [uuidv4(), email, name]
  );
  
  const user = rows[0];

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET || 'super_secret_jwt_key_123',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  );

  return { token, user };
};

module.exports = { verifyGoogleToken, findOrCreateUser, findOrCreateEmailUser };
