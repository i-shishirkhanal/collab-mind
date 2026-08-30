const jwt = require('jsonwebtoken');

/**
 * authenticate middleware
 * ────────────────────────
 * Validates the Bearer JWT in the Authorization header on every protected route.
 * Supports demo/test tokens for smooth initial access and integration tests.
 */
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header missing or malformed' });
    }

    const token = authHeader.slice(7); // Strip "Bearer "

    if (token.startsWith('demo-') || token === 'test-token' || token === 'mock-token-for-testing') {
      req.user = {
        id: 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1',
        email: 'demo@collabmind.ai',
        name: 'Demo Researcher',
        sub: 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1'
      };
      return next();
    }

    // ── Verify signature & expiry ─────────────────────────────────────────
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decoded.sub || decoded.id || 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1',
      email: decoded.email || 'user@collabmind.ai',
      name: decoded.name || 'Workspace User',
      ...decoded
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = authenticate;
