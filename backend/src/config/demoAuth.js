/**
 * Demo/test tokens ("demo-*", "test-token", ...) map to a shared demo user so
 * the app is usable without a backend login during development.
 *
 * They must never work in production: anyone could otherwise impersonate the
 * demo user and, through it, join that user's chats and calls.
 * Set ALLOW_DEMO_AUTH=true to opt in explicitly outside development.
 */
const demoAuthAllowed = () =>
  process.env.ALLOW_DEMO_AUTH === 'true' || process.env.NODE_ENV !== 'production';

const isDemoToken = (token) =>
  typeof token === 'string' &&
  (token.startsWith('demo-') || token === 'test-token' || token === 'mock-token-for-testing');

module.exports = { demoAuthAllowed, isDemoToken };
