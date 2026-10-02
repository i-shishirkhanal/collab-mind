const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// Replace the pg pool with an in-memory stub so no database is needed.
const calls = [];
let nextRows = [];
const poolStub = {
  query: async (text, params) => { calls.push({ text, params }); return { rows: nextRows, rowCount: nextRows.length }; },
  connect: async () => { throw new Error('connect not stubbed'); },
  on: () => {},
};
const poolPath = require.resolve(path.join(__dirname, '../src/db/postgres'));
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: poolStub };

const livekit = require('../src/services/livekitService');
const { isUuid, escapeLike, requireUuidParams } = require('../src/utils/http');
const { directKey, assertMember } = require('../src/services/conversationService');
const { isAllowedFileType } = require('../src/services/messageService');

beforeEach(() => {
  calls.length = 0;
  nextRows = [];
});

const withEnv = (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try { return fn(); } finally {
    Object.entries(before).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
};

// ── LiveKit tokens ────────────────────────────────────────────────────────────
test('LiveKit token carries room grant, identity and is signed with the API secret', () => {
  withEnv({ LIVEKIT_URL: 'wss://x.livekit.cloud', LIVEKIT_API_KEY: 'APIkey', LIVEKIT_API_SECRET: 'shh-secret' }, () => {
    const { token, url } = livekit.issueJoinCredentials({ callId: 'abc', userId: 'user-1', userName: 'Ada' });
    assert.equal(url, 'wss://x.livekit.cloud');
    const claims = jwt.verify(token, 'shh-secret', { algorithms: ['HS256'] });
    assert.equal(claims.iss, 'APIkey');
    assert.equal(claims.sub, 'user-1');
    assert.equal(claims.name, 'Ada');
    assert.equal(claims.video.room, 'call-abc');
    assert.equal(claims.video.roomJoin, true);
    assert.ok(claims.exp > claims.iat);
    assert.equal(claims.video.roomAdmin, undefined, 'participants must not get admin rights');
    assert.throws(() => jwt.verify(token, 'wrong-secret'), /invalid signature/);
  });
});

test('LiveKit credentials are refused with 503 when not configured', () => {
  withEnv({ LIVEKIT_URL: undefined, LIVEKIT_API_KEY: undefined, LIVEKIT_API_SECRET: undefined }, () => {
    assert.equal(livekit.isConfigured(), false);
    assert.throws(
      () => livekit.issueJoinCredentials({ callId: 'a', userId: 'u', userName: 'n' }),
      (err) => err.status === 503,
    );
  });
});

// Authentication (demo-token removal, session verification) is covered in auth.test.js.

// ── Helpers ───────────────────────────────────────────────────────────────────
test('directKey is order-independent so a pair has exactly one direct thread', () => {
  assert.equal(directKey('b', 'a'), directKey('a', 'b'));
  assert.notEqual(directKey('a', 'b'), directKey('a', 'c'));
});

test('UUID param guard rejects malformed ids with 400', () => {
  assert.equal(isUuid('3fa85f64-5717-4562-b3fc-2c963f66afa6'), true);
  assert.equal(isUuid("1'; DROP TABLE messages;--"), false);
  let err;
  requireUuidParams('conversationId')({ params: { conversationId: 'nope' } }, {}, (e) => { err = e; });
  assert.equal(err.status, 400);
});

test('escapeLike neutralises wildcard characters in user search', () => {
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
});

test('attachment allow-list blocks script/markup/executable types', () => {
  for (const ok of ['image/png', 'application/pdf', 'text/plain', 'video/mp4', 'application/zip']) {
    assert.equal(isAllowedFileType(ok), true, ok);
  }
  for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', 'application/x-msdownload', '', undefined]) {
    assert.equal(isAllowedFileType(bad), false, String(bad));
  }
});

// ── Authorization ─────────────────────────────────────────────────────────────
test('non-members get 404 for a conversation (no existence leak)', async () => {
  nextRows = [];
  await assert.rejects(
    assertMember('3fa85f64-5717-4562-b3fc-2c963f66afa6', '4fa85f64-5717-4562-b3fc-2c963f66afa6'),
    (err) => err.status === 404,
  );
  assert.match(calls[0].text, /conversation_members/);
});

test('members pass the membership check', async () => {
  nextRows = [{ role: 'member', last_read_at: new Date(), type: 'group' }];
  const m = await assertMember('3fa85f64-5717-4562-b3fc-2c963f66afa6', '4fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(m.role, 'member');
});
