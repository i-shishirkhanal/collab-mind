const authService = require('../services/authService');

/**
 * googleAuth — POST /auth/google
 * ───────────────────────────────
 * Accepts a Google ID token from the client (obtained after the user completes
 * Google Sign-In), verifies it with Google's servers, then finds or creates a
 * local user record, and returns a signed JWT for subsequent API calls.
 *
 * Request body: { idToken: string }
 * Response:     { token: string, user: { id, email, name, avatar_url } }
 */
const googleAuth = async (req, res, next) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    // 1. Verify the Google ID token
    const googlePayload = await authService.verifyGoogleToken(idToken);

    // 2. Find or create the user, and mint a JWT
    const { token, user } = await authService.findOrCreateUser(googlePayload);

    return res.status(200).json({ token, user });
  } catch (err) {
    next(err);
  }
};

const emailAuth = async (req, res, next) => {
  try {
    const { email, name } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    const { token, user } = await authService.findOrCreateEmailUser(email, name);
    return res.status(200).json({ token, user });
  } catch (err) {
    next(err);
  }
};

module.exports = { googleAuth, emailAuth };
