const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');

// ── Test environment: local storage in a temp dir, no GCS ─────────────────────
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabmind-uploads-'));
process.env.UPLOADS_DIR = uploadsDir;
delete process.env.GCS_BUCKET_NAME;

const stub = (relative, exports) => {
  const resolved = require.resolve(path.join(__dirname, relative));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// ── In-memory stand-in for the tables the source routes touch ─────────────────
const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // owner of A
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // member of A
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // admin of A
const DAVE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';  // member of B only

let members;
let sources;
let failNextInsert = false;
const aiCalls = [];

const poolStub = {
  on: () => {},
  query: async (text, params) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM workspace_members')) {
      const row = members.find((m) => m.workspace_id === params[0] && m.user_id === params[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("metadata->>'sha256'")) {
      const row = sources.find((s) => s.workspace_id === params[0] && s.metadata.sha256 === params[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('INSERT INTO sources')) {
      if (failNextInsert) { failNextInsert = false; throw new Error('db down'); }
      const [id, workspace_id, name, type, url, metadata, created_by] = params;
      const row = { id, workspace_id, name, type, url, metadata: JSON.parse(metadata), status: 'processing', created_by, updated_at: new Date() };
      sources.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM sources WHERE id = $1 AND workspace_id = $2')) {
      return { rows: sources.filter((s) => s.id === params[0] && s.workspace_id === params[1]) };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM sources WHERE workspace_id = $1')) {
      return { rows: sources.filter((s) => s.workspace_id === params[0]) };
    }
    if (sql.startsWith('DELETE FROM sources')) {
      const i = sources.findIndex((s) => s.id === params[0] && s.workspace_id === params[1]);
      if (i === -1) return { rows: [] };
      const [row] = sources.splice(i, 1);
      return { rows: [{ id: row.id, url: row.url, type: row.type }] };
    }
    if (sql.startsWith("UPDATE sources SET status = 'processing'")) { // beginRetry
      const s = sources.find((x) => x.id === params[0] && x.workspace_id === params[1]);
      if (!s || s.status !== 'failed') return { rows: [] };
      s.status = 'processing';
      delete s.metadata.error;
      s.metadata.stage = 'queued';
      s.metadata.attempts = (s.metadata.attempts || 0) + 1;
      return { rows: [s] };
    }
    if (sql.startsWith("UPDATE sources SET status = 'failed'")) { // markSourceFailed
      const s = sources.find((x) => x.id === params[0] && x.workspace_id === params[1]);
      if (s && s.status === 'processing') { s.status = 'failed'; Object.assign(s.metadata, JSON.parse(params[2])); }
      return { rows: [] };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  },
};

stub('../src/db/postgres', poolStub);
// Authentication belongs to Phase 1; here a header just says who is calling.
stub('../src/middleware/authenticate', (req, res, next) => {
  const id = req.headers['x-test-user'];
  if (!id) return res.status(401).json({ error: 'unauthenticated' });
  req.user = { id };
  next();
});
stub('../src/services/aiClient', {
  post: async (url, body) => { aiCalls.push({ url, body }); return { data: {} }; },
});

const express = require('express');
const sourceRoutes = require('../src/routes/sources');

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces', sourceRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/workspaces`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

beforeEach(() => {
  members = [
    { user_id: ALICE, workspace_id: WS_A, role: 'owner' },
    { user_id: BOB, workspace_id: WS_A, role: 'member' },
    { user_id: CAROL, workspace_id: WS_A, role: 'admin' },
    { user_id: DAVE, workspace_id: WS_B, role: 'owner' },
  ];
  sources = [];
  aiCalls.length = 0;
  failNextInsert = false;
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
const upload = (user, workspace, { name, content, type = 'application/octet-stream' }) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  return fetch(`${base}/${workspace}/sources/upload`, { method: 'POST', headers: user ? { 'x-test-user': user } : {}, body: form });
};
const call = (user, method, url) => fetch(`${base}${url}`, { method, headers: user ? { 'x-test-user': user } : {} });
const storedFiles = () => {
  const out = [];
  const walk = (d) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name))));
  walk(uploadsDir);
  return out;
};
const seed = (over = {}) => {
  const s = { id: crypto.randomUUID(), workspace_id: WS_A, name: 'x.pdf', type: 'pdf', url: null, status: 'failed', metadata: { error: 'boom', attempts: 1 }, created_by: BOB, updated_at: new Date(), ...over };
  sources.push(s);
  return s;
};

// ── Upload: happy path ────────────────────────────────────────────────────────
test('valid PDF upload is stored in the workspace folder, recorded as processing, and sent to the AI service', async () => {
  const res = await upload(BOB, WS_A, { name: 'paper.pdf', content: PDF, type: 'application/pdf' });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'processing');

  const row = sources.find((s) => s.id === body.source_id);
  assert.equal(row.workspace_id, WS_A);
  assert.equal(row.created_by, BOB);
  assert.equal(row.metadata.stage, 'queued');
  assert.equal(row.metadata.sha256, crypto.createHash('sha256').update(PDF).digest('hex'));

  const [file] = storedFiles();
  assert.ok(file.includes(path.join('workspaces', WS_A, 'sources')));
  assert.deepEqual(fs.readFileSync(file), PDF);

  await new Promise((r) => setImmediate(r));
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].url, '/embed');
  assert.equal(aiCalls[0].body.workspace_id, WS_A);
  assert.equal(aiCalls[0].body.source_id, body.source_id);
  assert.equal(aiCalls[0].body.storage_url, row.url);
});

test('plain text upload is accepted', async () => {
  const res = await upload(BOB, WS_A, { name: 'notes.txt', content: 'Plants make sugar from light.', type: 'text/plain' });
  assert.equal(res.status, 202);
  assert.equal(sources[0].type, 'text');
});

// ── Upload: rejections never touch storage or the database ────────────────────
for (const [label, name, content, status, pattern] of [
  ['empty file', 'empty.txt', '', 400, /empty/i],
  ['unsupported extension', 'tool.exe', 'MZ......', 400, /Unsupported/],
  ['PDF extension with non-PDF content', 'fake.pdf', 'just some text', 400, /valid PDF/],
  ['Word extension with non-zip content', 'fake.docx', 'just some text', 400, /valid Word/],
  ['text extension containing binary data', 'notes.txt', Buffer.from([0x68, 0x00, 0x69]), 400, /text file/],
]) {
  test(`upload rejects ${label}`, async () => {
    const res = await upload(BOB, WS_A, { name, content });
    assert.equal(res.status, status);
    assert.match((await res.json()).error, pattern);
    assert.equal(sources.length, 0);
    assert.deepEqual(storedFiles(), []);
    assert.equal(aiCalls.length, 0);
  });
}

test('oversized upload is rejected with 413', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(50 * 1024 * 1024 + 10)]);
  const res = await upload(BOB, WS_A, { name: 'big.pdf', content: big });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
  assert.deepEqual(storedFiles(), []);
});

test('path traversal in the filename cannot escape the upload folder', async () => {
  const res = await upload(BOB, WS_A, { name: '../../../etc/passwd.txt', content: 'hello there' });
  assert.equal(res.status, 202);
  const files = storedFiles();
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith(uploadsDir + path.sep));
  assert.equal(path.basename(files[0]), 'passwd.txt');
  assert.equal(sources[0].name, 'passwd.txt');
});

test('identical content in the same workspace is rejected as a duplicate (409) and not stored twice', async () => {
  const first = await upload(BOB, WS_A, { name: 'a.txt', content: 'same words here' });
  const { source_id } = await first.json();
  const second = await upload(ALICE, WS_A, { name: 'b.txt', content: 'same words here' });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).source_id, source_id);
  assert.equal(sources.length, 1);
  assert.equal(storedFiles().length, 1);
});

test('the same content in a different workspace is not a duplicate', async () => {
  assert.equal((await upload(BOB, WS_A, { name: 'a.txt', content: 'shared text' })).status, 202);
  assert.equal((await upload(DAVE, WS_B, { name: 'a.txt', content: 'shared text' })).status, 202);
  assert.equal(sources.length, 2);
});

test('a failed database insert removes the file that was just stored', async () => {
  failNextInsert = true;
  const res = await upload(BOB, WS_A, { name: 'a.txt', content: 'some text here' });
  assert.equal(res.status, 500);
  assert.deepEqual(storedFiles(), []);
});

// ── Authorization on every route ──────────────────────────────────────────────
test('unauthenticated requests are rejected on every source route', async () => {
  const s = seed();
  for (const [method, url] of [
    ['GET', `/${WS_A}/sources`], ['GET', `/${WS_A}/sources/${s.id}`],
    ['DELETE', `/${WS_A}/sources/${s.id}`], ['POST', `/${WS_A}/sources/${s.id}/retry`],
    ['POST', `/${WS_A}/sources/url`],
  ]) {
    assert.equal((await call(null, method, url)).status, 401, `${method} ${url}`);
  }
  assert.equal((await upload(null, WS_A, { name: 'a.txt', content: 'x' })).status, 401);
});

test('a non-member gets 403 on every source route and cannot upload', async () => {
  const s = seed();
  for (const [method, url] of [
    ['GET', `/${WS_A}/sources`], ['GET', `/${WS_A}/sources/${s.id}`],
    ['DELETE', `/${WS_A}/sources/${s.id}`], ['POST', `/${WS_A}/sources/${s.id}/retry`],
    ['POST', `/${WS_A}/sources/url`],
  ]) {
    assert.equal((await call(DAVE, method, url)).status, 403, `${method} ${url}`);
  }
  assert.equal((await upload(DAVE, WS_A, { name: 'a.txt', content: 'x' })).status, 403);
  assert.equal(sources.length, 1);
  assert.deepEqual(storedFiles(), []);
});

test('a member of workspace B cannot reach workspace A\'s source through workspace B\'s URL', async () => {
  const s = seed();
  assert.equal((await call(DAVE, 'GET', `/${WS_B}/sources/${s.id}`)).status, 404);
  assert.equal((await call(DAVE, 'DELETE', `/${WS_B}/sources/${s.id}`)).status, 404);
  assert.equal((await call(DAVE, 'POST', `/${WS_B}/sources/${s.id}/retry`)).status, 404);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].status, 'failed');
});

test('malformed ids are rejected before reaching the database', async () => {
  assert.equal((await call(BOB, 'GET', `/not-a-uuid/sources`)).status, 400);
  assert.equal((await call(BOB, 'GET', `/${WS_A}/sources/not-a-uuid`)).status, 400);
});

test('list only returns the caller\'s workspace', async () => {
  seed({ name: 'a.pdf' });
  seed({ name: 'b.pdf', workspace_id: WS_B });
  const res = await call(BOB, 'GET', `/${WS_A}/sources`);
  assert.deepEqual((await res.json()).map((s) => s.name), ['a.pdf']);
});

// ── Delete: creator or admin/owner only ───────────────────────────────────────
test('a member cannot delete a source someone else added', async () => {
  const s = seed({ created_by: ALICE });
  assert.equal((await call(BOB, 'DELETE', `/${WS_A}/sources/${s.id}`)).status, 403);
  assert.equal(sources.length, 1);
});

test('the creator can delete their source and its stored file is removed', async () => {
  const up = await upload(BOB, WS_A, { name: 'a.txt', content: 'delete me please' });
  const { source_id } = await up.json();
  assert.equal(storedFiles().length, 1);
  assert.equal((await call(BOB, 'DELETE', `/${WS_A}/sources/${source_id}`)).status, 204);
  assert.equal(sources.length, 0);
  assert.deepEqual(storedFiles(), []);
});

test('workspace admins and owners can delete any source', async () => {
  for (const user of [CAROL, ALICE]) {
    const s = seed({ created_by: BOB });
    assert.equal((await call(user, 'DELETE', `/${WS_A}/sources/${s.id}`)).status, 204);
  }
  assert.equal(sources.length, 0);
});

// ── Retry ─────────────────────────────────────────────────────────────────────
test('retrying a failed source re-queues it, clears the error and re-triggers processing', async () => {
  const s = seed({ url: 'local:///x/y.pdf' });
  const res = await call(BOB, 'POST', `/${WS_A}/sources/${s.id}/retry`);
  assert.equal(res.status, 202);
  assert.equal(s.status, 'processing');
  assert.equal(s.metadata.error, undefined);
  assert.equal(s.metadata.attempts, 2);
  await new Promise((r) => setImmediate(r));
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].body.storage_url, 'local:///x/y.pdf');
});

test('a ready or in-progress source cannot be retried (409) and nothing is triggered', async () => {
  const ready = seed({ status: 'ready', metadata: {} });
  const busy = seed({ status: 'processing', metadata: {} });
  assert.equal((await call(BOB, 'POST', `/${WS_A}/sources/${ready.id}/retry`)).status, 409);
  assert.equal((await call(BOB, 'POST', `/${WS_A}/sources/${busy.id}/retry`)).status, 409);
  assert.equal(aiCalls.length, 0);
});

test('if the AI service is unreachable the source is marked failed, not left processing', async () => {
  const aiClient = require('../src/services/aiClient');
  const original = aiClient.post;
  aiClient.post = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const res = await upload(BOB, WS_A, { name: 'a.txt', content: 'hello world text' });
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sources[0].status, 'failed');
    assert.match(sources[0].metadata.error, /unavailable/);
  } finally {
    aiClient.post = original;
  }
});

test('GET one source exposes status, stage and error', async () => {
  const s = seed({ metadata: { error: 'No readable text was found in this file.', stage: 'failed' } });
  const body = await (await call(BOB, 'GET', `/${WS_A}/sources/${s.id}`)).json();
  assert.equal(body.status, 'failed');
  assert.equal(body.metadata.stage, 'failed');
  assert.match(body.metadata.error, /No readable text/);
});
