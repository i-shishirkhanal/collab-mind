// Regression tests for the 2026-10-03 audit fixes. Dependencies are stubbed through the require
// cache, so no database or Redis is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const src = (p) => path.resolve(__dirname, '..', 'src', p);
const stub = (p, exports) => {
  const file = require.resolve(src(p));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

test('attachments: content must match the claimed type', () => {
  stub('db/postgres', { query: async () => ({ rows: [] }), connect: async () => ({}) });
  stub('services/realtime', {});
  stub('services/chatStorage', {});
  stub('services/conversationService', { assertMember: async () => ({}) });
  delete require.cache[require.resolve(src('services/messageService'))];
  const { contentMatchesType } = require(src('services/messageService'));

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  assert.equal(contentMatchesType('image/png', png), true);
  assert.equal(contentMatchesType('image/png', Buffer.from('<html><script>alert(1)</script>')), false);
  assert.equal(contentMatchesType('application/pdf', Buffer.from('%PDF-1.7 ...')), true);
  assert.equal(contentMatchesType('application/pdf', Buffer.from('MZ\x90\x00')), false);
  assert.equal(contentMatchesType('text/plain', Buffer.from('hello')), true);
  assert.equal(contentMatchesType('text/plain', Buffer.from([0x68, 0x00, 0x69])), false);
  assert.equal(contentMatchesType('image/png', Buffer.alloc(0)), false);
  assert.equal(contentMatchesType('audio/mpeg', Buffer.from('ID3')), true);
});

test('rate limiter falls back to memory instead of hanging when Redis does not answer', async () => {
  const never = new Promise(() => {});
  stub('db/redis', { multi: () => ({ incr() { return this; }, pttl() { return this; }, exec: () => never }) });
  process.env.RATE_LIMIT_STORE = 'redis';
  delete require.cache[require.resolve(src('middleware/rateLimit'))];
  const { rateLimit, _resetForTests } = require(src('middleware/rateLimit'));
  _resetForTests();

  const limiter = rateLimit({ name: 'audit', windowMs: 60_000, max: 1, keyFn: () => 'k' });
  const run = () => new Promise((resolve) => {
    const res = { set() {}, status(c) { this.code = c; return this; }, json() { resolve(this.code || 200); } };
    limiter({}, res, () => resolve(200));
  });
  const started = Date.now();
  assert.equal(await run(), 200);
  assert.equal(await run(), 429, 'memory fallback still enforces the limit');
  assert.ok(Date.now() - started < 5000, 'did not wait on the stalled Redis');
  delete process.env.RATE_LIMIT_STORE;
});
