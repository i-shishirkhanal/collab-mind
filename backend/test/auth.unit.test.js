// Unit tests for the auth primitives. No database, Redis or network needed.
process.env.NODE_ENV = 'test';
process.env.PASSWORD_SCRYPT_LOG_N = '10'; // fast hashing for tests only
process.env.JWT_SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef';
process.env.AI_SERVICE_TOKEN = 'unit-test-ai-token-0123456789abcdef0123456789';
process.env.DATABASE_URL = 'postgresql://x:x@127.0.0.1:1/x';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// In-memory pool stub: records queries, returns whatever the test queues.
let queued = [];
const calls = [];
const poolStub = {
  query: async (text, params) => { calls.push({ text, params }); return queued.length ? queued.shift() : { rows: [], rowCount: 0 }; },
  connect: async () => { throw new Error('not stubbed'); },
  on: () => {},
};
const poolPath = require.resolve(path.join(__dirname, '../src/db/postgres'));
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: poolStub };

const cfg = require('../src/config/env');
const { hashPassword, verifyPassword, passwordPolicyError } = require('../src/utils/passwords');
const authenticate = require('../src/middleware/authenticate');
const { rateLimit, _resetForTests } = require('../src/middleware/rateLimit');
const { assertPublicHttpUrl, isPrivateAddress } = require('../src/services/../utils/urlSafety');
const { roleAtLeast, can } = require('../src/services/workspaceAccess');
const { errorHandler } = require('../src/middleware/errorHandler');
const { normalizeEmail } = require('../src/services/authService');

beforeEach(() => { queued = []; calls.length = 0; _resetForTests(); });

const withEnv = (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try { return fn(); } finally {
    Object.entries(before).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
};

const run = async (mw, req) => {
  const out = { status: null, body: null, nextCalled: false, headers: {} };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
    set(k, v) { out.headers[k] = v; return this; },
  };
  out.req = { headers: {}, body: {}, ...req };
  await mw(out.req, res, (err) => { out.nextCalled = true; out.err = err; });
  return out;
};

// ── config ──────────────────────────────────────────────────────────────────
test('JWT_SECRET: missing, short and placeholder secrets are refused', () => {
  withEnv({ JWT_SECRET: undefined }, () => assert.throws(() => cfg.jwtSecret(), /required/));
  withEnv({ JWT_SECRET: 'short' }, () => assert.throws(() => cfg.jwtSecret(), /at least 32/));
  withEnv({ JWT_SECRET: 'super_secret_jwt_key_123' }, () => assert.throws(() => cfg.jwtSecret()));
  withEnv({ JWT_SECRET: 'your_super_secret_jwt_key_here_padding_padding' }, () => assert.throws(() => cfg.jwtSecret(), /placeholder/));
  assert.doesNotThrow(() => cfg.jwtSecret());
});

test('validateConfig: wildcard CORS and production without SMTP are refused', () => {
  withEnv({ CORS_ORIGINS: '*' }, () => assert.throws(() => cfg.validateConfig(), /CORS_ORIGINS/));
  withEnv({ NODE_ENV: 'production', SMTP_URL: undefined }, () => assert.throws(() => cfg.validateConfig(), /SMTP_URL/));
  withEnv({ AI_SERVICE_TOKEN: undefined }, () => assert.throws(() => cfg.validateConfig(), /AI_SERVICE_TOKEN/));
  assert.doesNotThrow(() => cfg.validateConfig());
});

test('JWT_EXPIRES_IN parses units and is capped at 30 days', () => {
  withEnv({ JWT_EXPIRES_IN: '12h' }, () => assert.equal(cfg.sessionTtlSeconds(), 43200));
  withEnv({ JWT_EXPIRES_IN: '365d' }, () => assert.equal(cfg.sessionTtlSeconds(), 30 * 86400));
  withEnv({ JWT_EXPIRES_IN: 'forever' }, () => assert.throws(() => cfg.sessionTtlSeconds()));
});

// ── passwords ───────────────────────────────────────────────────────────────
test('passwords are scrypt-hashed with unique salts and verify correctly', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.match(a, /^scrypt\$\d+\$8\$2\$/);
  assert.notEqual(a, b);
  assert.ok(!a.includes('correct horse'));
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('wrong horse battery', a), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', null), false);
});

test('password policy', () => {
  assert.match(passwordPolicyError('short'), /at least 6/);
  assert.match(passwordPolicyError('a'.repeat(129)), /at most/);
  assert.match(passwordPolicyError('aaaaaaaaaaaa'), /too simple/);
  assert.match(passwordPolicyError('ada@example.com', 'ada@example.com'), /email/);
  assert.equal(passwordPolicyError('a decent passphrase', 'ada@example.com'), null);
});

test('email normalisation', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(normalizeEmail(`${'a'.repeat(250)}@x.com`), null);
});

// ── authenticate: everything that must fail before touching the database ───
const sign = (claims = {}, secret = process.env.JWT_SECRET, opts = {}) => jwt.sign(
  claims, secret,
  { algorithm: 'HS256', issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE,
    subject: '11111111-1111-4111-8111-111111111111', jwtid: '22222222-2222-4222-8222-222222222222', expiresIn: 60, ...opts },
);
const asBearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });

test('authenticate: missing/malformed header and legacy demo tokens are 401', async () => {
  for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }]) {
    const r = await run(authenticate, { headers });
    assert.equal(r.status, 401); assert.equal(r.nextCalled, false);
  }
  for (const t of ['demo-guest-token', 'demo-token-x', 'test-token', 'mock-token-for-testing']) {
    const r = await run(authenticate, asBearer(t));
    assert.equal(r.status, 401, t); assert.equal(r.nextCalled, false);
  }
  assert.equal(calls.length, 0, 'bad tokens never reach the database');
});

test('authenticate: alg=none, wrong secret, wrong issuer/audience, expired, and old-style claim tokens are 401', async () => {
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: '11111111-1111-4111-8111-111111111111', jti: '22222222-2222-4222-8222-222222222222', iss: cfg.JWT_ISSUER, aud: cfg.JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.`;
  const cases = {
    none,
    wrongSecret: sign({}, 'another-secret-another-secret-another-secret'),
    wrongIssuer: sign({}, undefined, { issuer: 'evil' }),
    wrongAudience: sign({}, undefined, { audience: 'evil' }),
    expired: sign({}, undefined, { expiresIn: -30 }),
    // The pre-Phase-1 token shape ({id,email,name}, no iss/aud/jti) signed with the real secret
    legacyShape: jwt.sign({ id: 'u-1', email: 'a@b.c', name: 'A' }, process.env.JWT_SECRET),
    noJti: jwt.sign({}, process.env.JWT_SECRET, { issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE, subject: '11111111-1111-4111-8111-111111111111' }),
    nonUuidSub: sign({}, undefined, { subject: 'not-a-uuid' }),
    hs512: sign({}, undefined, { algorithm: 'HS512' }),
  };
  for (const [name, token] of Object.entries(cases)) {
    const r = await run(authenticate, asBearer(token));
    assert.equal(r.status, 401, name); assert.equal(r.nextCalled, false, name);
  }
  assert.equal((await run(authenticate, asBearer(cases.expired))).body.code, 'TOKEN_EXPIRED');
  assert.equal(calls.length, 0, 'invalid tokens never reach the database');
});

test('authenticate: a correctly signed token still needs a live session row', async () => {
  queued = [{ rows: [], rowCount: 0 }];
  const r = await run(authenticate, asBearer(sign()));
  assert.equal(r.status, 401);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /revoked_at IS NULL/);
  assert.match(calls[0].text, /email_verified_at IS NOT NULL/);
});

test('authenticate: live session sets exactly {id,email,name,sessionId} on req.user', async () => {
  queued = [{ rows: [{ id: '11111111-1111-4111-8111-111111111111', email: 'a@b.co', name: 'A', session_id: '22222222-2222-4222-8222-222222222222', expires_at: new Date() }] }];
  const req = asBearer(sign({ role: 'admin', isAdmin: true }));
  const r = await run(authenticate, req);
  assert.equal(r.nextCalled, true);
  assert.deepEqual(Object.keys(r.req.user).sort(), ['email', 'id', 'name', 'sessionId']);
});

test('authenticate: database failure is a 500 path, not an accepted login', async () => {
  poolStub.query = async () => { throw new Error('db down'); };
  const r = await run(authenticate, asBearer(sign()));
  assert.equal(r.nextCalled, true);
  assert.ok(r.err);
  assert.equal(r.status, null);
  poolStub.query = async (text, params) => { calls.push({ text, params }); return queued.length ? queued.shift() : { rows: [], rowCount: 0 }; };
});

// ── rate limiting ───────────────────────────────────────────────────────────
test('rateLimit: blocks after max with 429 + Retry-After, keyed per identity', async () => {
  const mw = rateLimit({ name: 't', windowMs: 60_000, max: 3, keyFn: (req) => req.body.email });
  for (let i = 0; i < 3; i++) assert.equal((await run(mw, { body: { email: 'a@x.co' } })).nextCalled, true);
  const blocked = await run(mw, { body: { email: 'a@x.co' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.equal((await run(mw, { body: { email: 'b@x.co' } })).nextCalled, true, 'other identities unaffected');
});

// ── SSRF guard ──────────────────────────────────────────────────────────────
test('isPrivateAddress covers loopback, private, link-local/metadata, CGNAT, ULA and mapped IPv6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('assertPublicHttpUrl rejects internal targets before any fetch', async () => {
  for (const u of ['http://localhost:8000/health', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://ai.internal/', 'http://user:pw@8.8.8.8/', 'file:///etc/passwd', 'ftp://8.8.8.8/', 'not a url']) {
    await assert.rejects(() => assertPublicHttpUrl(u), (e) => e.status === 400, u);
  }
  await assert.doesNotReject(() => assertPublicHttpUrl('https://8.8.8.8/doc.pdf'));
});

// ── permissions matrix ──────────────────────────────────────────────────────
test('role hierarchy and permission table', () => {
  assert.equal(roleAtLeast('owner', 'admin'), true);
  assert.equal(roleAtLeast('member', 'admin'), false);
  assert.equal(roleAtLeast('hacker', 'member'), false, 'unknown roles get nothing');
  assert.equal(can('member', 'chat:write'), true);
  assert.equal(can('member', 'members:manage'), false);
  assert.equal(can('admin', 'workspace:delete'), false);
  assert.equal(can('owner', 'workspace:delete'), true);
  assert.equal(can('owner', 'nonexistent:action'), false, 'unknown actions are denied');
});

// ── error handler ───────────────────────────────────────────────────────────
test('errorHandler hides 5xx internals and keeps 4xx messages', () => {
  const mk = () => { const o = {}; return { o, res: { status(c) { o.status = c; return this; }, json(b) { o.body = b; return this; } } }; };
  const a = mk();
  errorHandler(Object.assign(new Error('relation "users" does not exist at pg:5432'), { code: '42P01' }), { method: 'GET', path: '/x' }, a.res);
  assert.equal(a.o.status, 500);
  assert.deepEqual(a.o.body, { error: 'Internal server error' });
  const withId = mk();
  errorHandler(new Error('boom'), { method: 'GET', path: '/x', id: 'req-12345678' }, withId.res);
  assert.deepEqual(withId.o.body, { error: 'Internal server error', requestId: 'req-12345678' });
  const b = mk();
  errorHandler(Object.assign(new Error('Invalid workspaceId'), { status: 400 }), { method: 'GET', path: '/x' }, b.res);
  assert.equal(b.o.status, 400);
  assert.equal(b.o.body.error, 'Invalid workspaceId');
});
