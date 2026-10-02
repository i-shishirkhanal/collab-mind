const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// OWASP-recommended scrypt cost (N=2^16, r=8, p=2). Tests may lower N for speed.
const costParams = () => {
  const logN = process.env.NODE_ENV === 'test' && process.env.PASSWORD_SCRYPT_LOG_N
    ? Number(process.env.PASSWORD_SCRYPT_LOG_N)
    : 16;
  return { N: 2 ** logN, r: 8, p: 2 };
};

const KEY_LEN = 64;
const maxmemFor = ({ N, r, p }) => 128 * N * r * p + 16 * 1024 * 1024;

const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

/** Returns an error string, or null when the password is acceptable. */
const passwordPolicyError = (password, email = '') => {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  const local = String(email).split('@')[0].toLowerCase();
  if (password.toLowerCase() === String(email).toLowerCase() || (local.length >= 4 && password.toLowerCase() === local)) {
    return 'Password must not be the same as your email';
  }
  if (/^(.)\1+$/.test(password)) return 'Password is too simple';
  return null;
};

/** -> "scrypt$N$r$p$saltB64$hashB64" */
const hashPassword = async (password) => {
  const params = costParams();
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...params, maxmem: maxmemFor(params) });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), derived.toString('base64')].join('$');
};

const verifyPassword = async (password, stored) => {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const params = { N: Number(N), r: Number(r), p: Number(p) };
    if (![params.N, params.r, params.p].every(Number.isInteger) || params.N > 2 ** 20) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      ...params, maxmem: maxmemFor(params),
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
};

// Used to spend the same time when an account does not exist (no user enumeration by timing).
let dummyHashPromise = null;
const verifyAgainstDummy = async (password) => {
  dummyHashPromise = dummyHashPromise || hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHashPromise);
  return false;
};

module.exports = { hashPassword, verifyPassword, verifyAgainstDummy, passwordPolicyError, PASSWORD_MIN, PASSWORD_MAX };
