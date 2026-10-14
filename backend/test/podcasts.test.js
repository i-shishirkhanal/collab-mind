const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { Readable } = require('node:stream');
const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const calls = [];
let aiFailure = null;
function stub(name, exports) {
  const id = require.resolve(path.join(__dirname, name));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../src/db/postgres', { query: async (sql, args) => {
  if (sql.includes('workspace_members')) return { rows: args[0] === WS ? [{ user_id: USER, role: 'member' }] : [] };
  if (sql.includes('WHERE id=$1 AND workspace_id=$2')) return { rows: args[0] === JOB && args[1] === WS ? [{ id: JOB, status: 'ready' }] : [] };
  return { rows: [] };
} });
stub('../src/middleware/authenticate', (req, res, next) => {
  if (!req.headers['x-test-user']) return res.status(401).json({ error: 'Sign in' });
  req.user = { id: USER }; next();
});
stub('../src/services/aiClient', {
  post: async (url, body) => { if (aiFailure) throw aiFailure; calls.push({ url, body }); return { data: { id: JOB, status: 'queued' } }; },
  get: async () => ({ data: { available: true } }),
  getStream: async url => { calls.push({ url }); return { headers: { 'content-length': '3' }, data: Readable.from([Buffer.from('ID3')]) }; },
});
let server, base;
before(async () => {
  const app = express(); app.use(express.json()); app.use('/api/workspaces', require('../src/routes/podcasts'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/workspaces`;
});
after(() => new Promise(resolve => server.close(resolve)));
const request = (url, body, auth = true) => fetch(base + url, {
  method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-test-user': USER } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
test('podcast start ignores forged workspace and user identities', async () => {
  const response = await request(`/${WS}/studio/podcasts`, { source_ids: [SOURCE], workspace_id: OTHER, user_id: OTHER });
  assert.equal(response.status, 202);
  assert.equal(calls.at(-1).body.workspace_id, WS);
  assert.equal(calls.at(-1).body.user_id, USER);
});
test('podcast operations require authentication and workspace membership', async () => {
  assert.equal((await request(`/${WS}/studio/podcasts`, null, false)).status, 401);
  assert.equal((await request(`/${OTHER}/studio/podcasts`)).status, 403);
  assert.equal((await request(`/${WS}/studio/podcasts`, { source_ids: ['invalid'] })).status, 400);
});
test('audio is checked against the workspace and streamed privately', async () => {
  assert.equal((await request(`/${WS}/studio/podcasts/${SOURCE}/audio`)).status, 404);
  const response = await request(`/${WS}/studio/podcasts/${JOB}/audio`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), 'ID3');
  assert.ok(calls.at(-1).url.endsWith(`workspace_id=${WS}`));
});
test('AI authentication errors are hidden as 502 rather than signing the browser out', async () => {
  aiFailure = { response: { status: 401, data: { detail: 'private credential' } } };
  try {
    const response = await request(`/${WS}/studio/podcasts`, { source_ids: [SOURCE] });
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('private credential'));
  } finally { aiFailure = null; }
});
