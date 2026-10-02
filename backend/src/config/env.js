/**
 * Central, validated runtime configuration for the security-sensitive settings.
 * Nothing here has an insecure fallback: a missing or weak secret is a startup
 * error, never a silent default.
 */
const KNOWN_PLACEHOLDERS = new Set([
  'super_secret_jwt_key_123',
  'your_super_secret_jwt_key_here',
  'super_secret_nextauth_key_123',
  'changeme',
  'change_me',
  'secret',
  'dummy',
]);

const MIN_SECRET_LENGTH = 32;

const isProduction = () => process.env.NODE_ENV === 'production';

const assertStrongSecret = (name, value) => {
  if (!value) throw new Error(`${name} is required`);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const lowered = value.toLowerCase();
  if (KNOWN_PLACEHOLDERS.has(lowered) || lowered.includes('your_') || lowered.includes('dummy')) {
    throw new Error(`${name} is a placeholder value; generate a random secret`);
  }
  return value;
};

const jwtSecret = () => assertStrongSecret('JWT_SECRET', process.env.JWT_SECRET);
const aiServiceToken = () => assertStrongSecret('AI_SERVICE_TOKEN', process.env.AI_SERVICE_TOKEN);

const JWT_ISSUER = 'collabmind-api';
const JWT_AUDIENCE = 'collabmind-app';

/** "7d" | "12h" | "30m" | "3600" (seconds) -> seconds. Capped at 30 days. */
const sessionTtlSeconds = () => {
  const raw = String(process.env.JWT_EXPIRES_IN || '7d').trim();
  const m = /^(\d+)\s*([smhd]?)$/.exec(raw);
  if (!m) throw new Error('JWT_EXPIRES_IN must look like 3600, 30m, 12h or 7d');
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  return Math.min(Number(m[1]) * unit, 30 * 86400);
};

const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

const corsOrigins = () =>
  (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Called once at startup so misconfiguration fails fast and loudly. */
const validateConfig = () => {
  jwtSecret();
  aiServiceToken();
  sessionTtlSeconds();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (corsOrigins().includes('*')) throw new Error('CORS_ORIGINS must list explicit origins, not "*"');
  if (isProduction() && !process.env.SMTP_URL) {
    throw new Error('SMTP_URL is required in production (verification and reset emails)');
  }
};

module.exports = {
  isProduction, jwtSecret, aiServiceToken, sessionTtlSeconds, appUrl, corsOrigins, validateConfig,
  JWT_ISSUER, JWT_AUDIENCE, MIN_SECRET_LENGTH,
};
