// Phase 4 regression tests (unit level; no database, Redis or network). Each test names the defect it guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const src = (p) => path.resolve(__dirname, '..', 'src', p);
const stub = (p, exports) => { const file = require.resolve(src(p)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
const fresh = (p) => { delete require.cache[require.resolve(src(p))]; return require(src(p)); };

// ── storage: a configured-but-failing bucket must not silently become local storage in production ──
test('GCS failure: production refuses the local fallback, development keeps it', async () => {
  const gcsPath = require.resolve('@google-cloud/storage');
  const original = require.cache[gcsPath];
  class FailingStorage {
    bucket() { return { file: () => ({ createWriteStream: () => { const { PassThrough } = require('node:stream'); const s = new PassThrough(); s.end = () => process.nextTick(() => s.emit('error', new Error('bucket unreachable'))); return s; } }) }; }
  }
  require.cache[gcsPath] = { id: gcsPath, filename: gcsPath, loaded: true, exports: { Storage: FailingStorage } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-up-'));
  const saved = { ...process.env };
  try {
    process.env.GCS_BUCKET_NAME = 'real-bucket'; process.env.UPLOADS_DIR = tmp;
    process.env.NODE_ENV = 'production'; delete process.env.ALLOW_LOCAL_STORAGE_FALLBACK;
    let storage = fresh('services/storageService');
    await assert.rejects(storage.uploadFileBuffer('11111111-1111-1111-1111-111111111111', Buffer.from('x'), 'a.txt', 'text/plain'),
      (e) => e.status === 503 && !/bucket unreachable/.test(e.message), 'production must fail, not write locally');
    assert.deepEqual(fs.readdirSync(tmp), [], 'nothing written to local disk in production');

    process.env.NODE_ENV = 'development';
    storage = fresh('services/storageService');
    const uri = await storage.uploadFileBuffer('11111111-1111-1111-1111-111111111111', Buffer.from('x'), 'a.txt', 'text/plain');
    assert.match(uri, /^local:\/\//, 'development falls back to local disk');
  } finally {
    Object.assign(process.env, saved); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    if (original) require.cache[gcsPath] = original; else delete require.cache[gcsPath];
    delete require.cache[require.resolve(src('services/storageService'))];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── sources: a slow embedding must not be reported as a failure ─────────────────────────────────
function sourceServiceWith(postImpl) {
  const queries = [];
  stub('db/postgres', { query: async (sql, params) => { queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: [] }; } });
  stub('services/aiClient', { post: postImpl });
  return { svc: fresh('services/sourceService'), queries };
}

test('/embed wait timing out leaves the source processing (the AI service owns the final status)', async () => {
  const { svc, queries } = sourceServiceWith(async () => { throw Object.assign(new Error('timeout of 300000ms exceeded'), { code: 'ECONNABORTED' }); });
  await svc.triggerAiEmbedding('w', 's', 'local://x');
  assert.equal(queries.length, 0, 'no UPDATE ... status = failed');
});

test('/embed unreachable or rejected (never started) marks the source failed with a safe message', async () => {
  for (const err of [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('401'), { response: { status: 401 } }), Object.assign(new Error('503'), { response: { status: 503 } })]) {
    const { svc, queries } = sourceServiceWith(async () => { throw err; });
    await svc.triggerAiEmbedding('w', 's', 'local://x');
    assert.equal(queries.length, 1, `failed once for ${err.message}`);
    assert.match(queries[0].sql, /status = 'failed'/); assert.match(queries[0].params[2], /unavailable/);
    assert.ok(!queries[0].params[2].includes('ECONNREFUSED'), 'internal error text is not stored');
  }
  const { svc, queries } = sourceServiceWith(async () => { throw Object.assign(new Error('500'), { response: { status: 500 } }); });
  await svc.triggerAiEmbedding('w', 's', 'local://x');
  assert.equal(queries.length, 0, 'an HTTP 500 means the AI service ran and recorded its own outcome');
});

test('stale-processing window defaults to 30 minutes (CPU embedding is slow)', async () => {
  const { svc, queries } = sourceServiceWith(async () => ({}));
  await svc.beginRetry('w', 's');
  assert.equal(queries[0].params[2], 30);
});

// ── rate limit on cost-bearing endpoints ────────────────────────────────────────────────────────
test('perUser limiter: per-user budget, 429 with Retry-After, independent between users, env-tunable', async () => {
  process.env.CHAT_RATE_LIMIT_PER_MIN = '2';
  const { perUser, _resetForTests } = fresh('middleware/rateLimit'); _resetForTests();
  const limiter = perUser('chat-t', 'CHAT_RATE_LIMIT_PER_MIN', 20);
  const run = async (id) => { const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; let nexted = false; await limiter({ user: { id }, ip: '1.1.1.1' }, res, () => { nexted = true; }); return { nexted, res }; };
  assert.equal((await run('u1')).nexted, true); assert.equal((await run('u1')).nexted, true);
  const third = await run('u1'); assert.equal(third.nexted, false); assert.equal(third.res.code, 429); assert.ok(Number(third.res.headers['Retry-After']) > 0);
  assert.equal((await run('u2')).nexted, true, 'another user is unaffected');
  delete process.env.CHAT_RATE_LIMIT_PER_MIN;
});

test('routes that call the LLM or ingest documents are behind a per-user limiter', () => {
  const read = (p) => fs.readFileSync(src(p), 'utf8');
  assert.match(read('routes/chat.js'), /chatLimit,\s*\n\s*requireWorkspaceMember,\s*\n\s*chatController\.sendMessage/);
  const agents = read('routes/agents.js');
  for (const r of ["agents/study-coach'", "agents/run'", "studio/flashcards'", "studio/quiz'", "studio/guide'", "studio/report'"]) {
    assert.match(agents, new RegExp(`${r.replace('/', '\\/')}, \\.\\.\\.costlyGuard`), r);
  }
  const sources = read('routes/sources.js');
  for (const frag of ['sources/upload\', authenticate, ingestLimit', 'sources/url\', authenticate, ingestLimit', 'summarize\', authenticate, summarizeLimit', 'retry\', authenticate, ingestLimit']) assert.ok(sources.includes(frag), frag);
  assert.ok(read('socket/handlers.js').includes("consume('chat'"), 'socket chat shares the budget');
});

test('only an owner or admin can approve or reject an agent run; any member can start one', () => {
  const { can } = require('../src/services/workspaceAccess');
  assert.equal(can('member', 'agents:run'), true);
  assert.equal(can('member', 'agents:approve'), false);
  assert.equal(can('admin', 'agents:approve'), true);
  assert.equal(can('owner', 'agents:approve'), true);
});

// ── deleting a workspace must also remove its uploaded files ───────────────────────────────────
test('deleteWorkspace removes stored files of file sources after the rows are deleted (not URL sources)', async () => {
  const calls = [];
  stub('db/postgres', { query: async (sql) => { calls.push(['sql', sql.replace(/\s+/g, ' ').trim()]); return /SELECT url FROM sources/.test(sql) ? { rows: [{ url: 'local:///up/a/x.pdf' }, { url: 'gs://b/y.pdf' }] } : { rows: [] }; }, connect: async () => ({}) });
  stub('services/storageService', { deleteStoredFile: async (u) => { calls.push(['file', u]); } });
  const ws = fresh('services/workspaceService');
  await ws.deleteWorkspace('11111111-1111-1111-1111-111111111111');
  assert.match(calls[0][1], /type NOT IN \('url', 'youtube'\)/, 'web-link sources have nothing in storage');
  assert.match(calls[1][1], /DELETE FROM workspaces/);
  assert.deepEqual(calls.filter(([k]) => k === 'file').map(([, u]) => u), ['local:///up/a/x.pdf', 'gs://b/y.pdf']);
  assert.ok(calls.findIndex(([k]) => k === 'file') > 1, 'files are removed only after the DB delete succeeded');
});
