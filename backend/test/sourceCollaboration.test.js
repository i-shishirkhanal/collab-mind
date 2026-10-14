const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const SECOND = '44444444-4444-4444-8444-444444444444';
const ANNOTATION = '55555555-5555-4555-8555-555555555555';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEXT = 'An experiment 🌱 shows improved learning.';
const calls = [];
const aiCalls = [];
let commentWrites = 0;
const stub = (name, exports) => {
  const id = require.resolve(path.join(__dirname, name));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
const query = async (sql, values = []) => {
  calls.push({ sql, values });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
  if (sql.includes('FROM workspace_members')) return { rows: values[0] === WS ? [{ user_id: USER, role: 'member' }] : [] };
  if (sql.includes('SELECT sc.content')) return { rows: values[0] === WS && values[1] === SOURCE ? [{ content: TEXT }] : [] };
  if (sql.includes('INSERT INTO source_annotations')) return { rows: [{ id: ANNOTATION }] };
  if (sql.includes('INSERT INTO annotation_comments')) { commentWrites++; return { rows: [{ id: SECOND }] }; }
  if (sql.includes('INSERT INTO annotation_mentions') || sql.includes('UPDATE source_annotations SET updated_at')) return { rows: [] };
  if (sql.includes('SELECT resolved FROM source_annotations')) return { rows: values[1] === WS && values[2] === SOURCE ? [{ resolved: false }] : [] };
  if (sql.includes('UPDATE source_annotations SET resolved')) return { rows: values[4] === USER || values[5] ? [{ id: ANNOTATION }] : [] };
  if (sql.includes('SELECT id, status FROM sources')) return { rows: values[0] === WS && values[1].every(id => [SOURCE, SECOND].includes(id)) ? [{ id: SOURCE, status: 'ready' }, { id: SECOND, status: 'ready' }] : [] };
  if (sql.includes('FROM source_chunks')) return { rows: [] };
  throw new Error(`Unexpected SQL: ${sql}`);
};
stub('../src/db/postgres', { query, connect: async () => ({ query, release() {} }) });
stub('../src/middleware/authenticate', (req, res, next) => {
  if (!req.headers['x-test-user']) return res.status(401).json({ error: 'Unauthenticated' });
  req.user = { id: req.headers['x-test-user'] }; next();
});
stub('../src/services/aiClient', { post: async (endpoint, payload) => { aiCalls.push({ endpoint, payload }); return { data: { findings: [] } }; } });
const annotations = require('../src/services/annotationService');
let server, url;
before(async () => {
  const app = express(); app.use(express.json());
  app.use('/api/workspaces', require('../src/routes/sourceCollaboration'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}/api/workspaces`;
});
after(() => new Promise(resolve => server.close(resolve)));
const request = (endpoint, body, user = USER, method = 'POST') => fetch(url + endpoint, {
  method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const selection = () => ({ chunk_index: 0, chunk_content: TEXT, start_offset: 14, end_offset: 16, body: 'Check this finding', mentions: [USER] });

test('annotation anchor preserves UTF-16 offsets, exact passage snapshot, and mentions in one transaction', async () => {
  const start = calls.length;
  const response = await request(`/${WS}/sources/${SOURCE}/annotations`, selection());
  assert.equal(response.status, 201);
  const written = calls.slice(start);
  assert.equal(written[0].sql.includes('FROM workspace_members'), true);
  const insert = written.find(c => c.sql.includes('INSERT INTO source_annotations'));
  assert.equal(insert.values[6], '🌱');
  assert.equal(insert.values[3], TEXT);
  assert.ok(written.some(c => c.sql.includes('INSERT INTO annotation_mentions')));
  assert.equal(written.at(-1).sql, 'COMMIT');
});
test('stale snapshots and out-of-bounds ranges are rejected without saving a comment', async () => {
  const writes = commentWrites;
  for (const input of [{ ...selection(), chunk_content: 'old text' }, { ...selection(), end_offset: 999 }]) {
    const response = await request(`/${WS}/sources/${SOURCE}/annotations`, input);
    assert.equal(response.status, 409);
  }
  assert.equal(commentWrites, writes);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});
test('foreign source, unauthenticated caller and foreign workspace are rejected', async () => {
  assert.equal((await request(`/${WS}/sources/${SECOND}/annotations`, selection())).status, 404);
  assert.equal((await request(`/${WS}/sources/${SOURCE}/annotations`, selection(), null)).status, 401);
  assert.equal((await request(`/${OTHER_WS}/sources/${SOURCE}/annotations`, selection())).status, 403);
});
test('nonmember mentions roll back the entire discussion', async () => {
  const writes = commentWrites;
  assert.equal((await request(`/${WS}/sources/${SOURCE}/annotations`, { ...selection(), mentions: [USER, OTHER] })).status, 400);
  assert.equal(commentWrites, writes);
});
test('resolve allows the author/admin but refuses another member', async () => {
  await assert.rejects(annotations.resolve(WS, SOURCE, ANNOTATION, OTHER, 'member', true), { status: 403 });
  assert.equal((await annotations.resolve(WS, SOURCE, ANNOTATION, OTHER, 'admin', true)).id, ANNOTATION);
});
test('reply cannot address a discussion through a different source', async () => {
  assert.equal((await request(`/${WS}/sources/${SECOND}/annotations/${ANNOTATION}/comments`, { body: 'reply' })).status, 404);
});
test('comparison rejects duplicate/foreign source IDs and overwrites forged workspace/user fields', async () => {
  assert.equal((await request(`/${WS}/sources/compare`, { source_ids: [SOURCE, SOURCE] })).status, 400);
  assert.equal((await request(`/${WS}/sources/compare`, { source_ids: [SOURCE, OTHER] })).status, 404);
  assert.equal((await request(`/${WS}/sources/compare`, { source_ids: [SOURCE, SECOND], workspace_id: OTHER_WS, user_id: OTHER })).status, 200);
  assert.deepEqual(aiCalls.at(-1).payload, { workspace_id: WS, user_id: USER, source_ids: [SOURCE, SECOND], focus: '' });
});
