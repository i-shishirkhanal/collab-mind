// Phase 4 database regression tests. Skipped unless TEST_DATABASE_URL points at a disposable database
// built from supabase/migrations/*.sql (see docs/phase4-test-report.md). Creates and removes its own rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : 'TEST_DATABASE_URL not set';
let pool;
const id = () => crypto.randomUUID();

test.before(async () => { if (!URL) return; const { Pool } = require('pg'); pool = new Pool({ connectionString: URL, max: 2 }); });
test.after(async () => { if (pool) await pool.end(); });

async function seedWorkspace() {
  const u = id(), w = id();
  await pool.query('INSERT INTO users(id,name,email,email_verified_at) VALUES ($1,$2,$3,NOW())', [u, 'p4', `${u}@p4.test`]);
  await pool.query('INSERT INTO workspaces(id,name,created_by) VALUES ($1,$2,$3)', [w, 'p4', u]);
  return { u, w, cleanup: async () => { await pool.query('DELETE FROM workspaces WHERE id=$1', [w]); await pool.query('DELETE FROM users WHERE id=$1', [u]); } };
}

test('agent_runs.finished_at exists (study-coach completion/failure writes it)', { skip }, async () => {
  const { w, cleanup } = await seedWorkspace(); const run = id();
  try {
    await pool.query("INSERT INTO agent_runs(id,workspace_id,agent_type,status) VALUES ($1,$2,'study_coach','started')", [run, w]);
    await pool.query("UPDATE agent_runs SET status='completed', result=$2, finished_at = NOW() WHERE id=$1", [run, '{}']);
    const { rows } = await pool.query('SELECT finished_at IS NOT NULL AS done FROM agent_runs WHERE id=$1', [run]);
    assert.equal(rows[0].done, true);
  } finally { await cleanup(); }
});

test('identical content cannot be stored twice in a workspace even under a race (unique index), but may exist in another workspace', { skip }, async () => {
  const a = await seedWorkspace(), b = await seedWorkspace();
  const sha = crypto.randomBytes(32).toString('hex');
  const insert = (w) => pool.query("INSERT INTO sources(id,workspace_id,name,type,status,metadata) VALUES ($1,$2,'x.pdf','pdf','processing',$3)", [id(), w, JSON.stringify({ sha256: sha })]);
  try {
    const settled = await Promise.allSettled([insert(a.w), insert(a.w), insert(a.w)]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, 'exactly one concurrent insert wins');
    const lost = settled.find((s) => s.status === 'rejected').reason;
    assert.equal(lost.code, '23505'); assert.match(lost.constraint, /sha256/);
    await insert(b.w); // same file in a different workspace is allowed
    await pool.query("INSERT INTO sources(id,workspace_id,name,type,status,metadata) VALUES ($1,$2,'u1','url','processing','{}'),($3,$2,'u2','url','processing','{}')", [id(), a.w, id()]); // sources without a hash are unconstrained
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('deleting a workspace cascades to its sources and chunks (rows only; files are removed by the service)', { skip }, async () => {
  const { u, w } = await seedWorkspace(); const s = id();
  await pool.query("INSERT INTO sources(id,workspace_id,name,type,status) VALUES ($1,$2,'x','pdf','ready')", [s, w]);
  await pool.query("INSERT INTO source_chunks(workspace_id,source_id,chunk_index,content,embedding) VALUES ($1,$2,0,'c', array_fill(0.1::real, ARRAY[1024])::vector)", [w, s]);
  await pool.query('DELETE FROM workspaces WHERE id=$1', [w]);
  assert.equal((await pool.query('SELECT 1 FROM source_chunks WHERE source_id=$1', [s])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM sources WHERE id=$1', [s])).rowCount, 0);
  await pool.query('DELETE FROM users WHERE id=$1', [u]);
});

test('vector column is 1024-d and rejects other sizes (no silent 768-d Gemini leftovers)', { skip }, async () => {
  const { w, cleanup } = await seedWorkspace(); const s = id();
  try {
    await pool.query("INSERT INTO sources(id,workspace_id,name,type,status) VALUES ($1,$2,'x','pdf','ready')", [s, w]);
    await assert.rejects(pool.query("INSERT INTO source_chunks(workspace_id,source_id,chunk_index,content,embedding) VALUES ($1,$2,0,'c', array_fill(0.1::real, ARRAY[768])::vector)", [w, s]), /1024/);
  } finally { await cleanup(); }
});

test('status columns reject values the services never write', { skip }, async () => {
  const { w, cleanup } = await seedWorkspace();
  try {
    await assert.rejects(
      pool.query("INSERT INTO sources(id,workspace_id,name,type,status) VALUES ($1,$2,'x','pdf','error')", [id(), w]),
      (e) => e.code === '23514' && /sources_status_check/.test(e.constraint));
    await assert.rejects(
      pool.query("INSERT INTO agent_runs(id,workspace_id,agent_type,status) VALUES ($1,$2,'study_coach','running')", [id(), w]),
      (e) => e.code === '23514' && /agent_runs_status_check/.test(e.constraint));
  } finally { await cleanup(); }
});

test('chat history: newest page first, then older pages via the cursor, with no gaps or loss', { skip }, async () => {
  process.env.DATABASE_URL = URL;
  const { getChatMessages } = require('../src/services/chatService');
  const { w, u, cleanup } = await seedWorkspace();
  try {
    await pool.query(
      `INSERT INTO chat_messages(id, workspace_id, user_id, role, content, created_at)
       SELECT gen_random_uuid(), $1, $2, 'user', 'm' || n, NOW() - make_interval(secs => 200 - n)
         FROM generate_series(1, 120) AS n`, [w, u]);
    const newest = await getChatMessages(w, 50);
    assert.equal(newest.length, 50);
    assert.equal(newest[49].content, 'm120');           // latest message is last
    assert.equal(newest[0].content, 'm71');             // oldest of the newest 50 comes first

    const seen = new Map(newest.map((m) => [m.id, m]));
    let page = newest;
    for (let i = 0; i < 5 && page.length; i += 1) {
      page = await getChatMessages(w, 50, new Date(page[0].created_at).toISOString());
      page.forEach((m) => seen.set(m.id, m));           // ties at the cursor may repeat; the client merges by id
    }
    assert.equal(seen.size, 120);
  } finally { await cleanup(); }
});

test('deleting a message erases its text and attachment reference and asks storage to remove the file', { skip }, async () => {
  process.env.DATABASE_URL = URL;
  const chatStorage = require('../src/services/chatStorage');
  const removed = [];
  const original = chatStorage.removeObjects;
  chatStorage.removeObjects = async (paths) => { removed.push(...paths); };
  const { u, w, cleanup } = await seedWorkspace(); const conv = id(); const msg = id();
  try {
    await pool.query("INSERT INTO conversations(id, type, direct_key) VALUES ($1,'direct',$2)", [conv, `k-${conv}`]);
    await pool.query("INSERT INTO conversation_members(conversation_id,user_id) VALUES ($1,$2)", [conv, u]);
    await pool.query(
      `INSERT INTO messages(id, conversation_id, sender_id, kind, body, attachment_path, attachment_name, attachment_type, attachment_size)
       VALUES ($1,$2,$3,'file','secret text','conv/abc/file.pdf','file.pdf','application/pdf',10)`, [msg, conv, u]);
    await require('../src/services/messageService').deleteMessage(conv, msg, u);
    const { rows } = await pool.query('SELECT body, attachment_path, attachment_name, deleted_at FROM messages WHERE id = $1', [msg]);
    assert.equal(rows[0].body, '');
    assert.equal(rows[0].attachment_path, null);
    assert.equal(rows[0].attachment_name, null);
    assert.ok(rows[0].deleted_at);
    assert.deepEqual(removed, ['conv/abc/file.pdf']);
    await assert.rejects(require('../src/services/messageService').deleteMessage(conv, msg, u), /not found/i); // already deleted
  } finally {
    chatStorage.removeObjects = original;
    await pool.query('DELETE FROM conversations WHERE id = $1', [conv]);
    await cleanup();
  }
});

test('a user removed from a conversation can neither rejoin its call nor mint a media token', { skip }, async () => {
  process.env.DATABASE_URL = URL;
  const calls = require('../src/services/callService');
  const a = await seedWorkspace(); const b = await seedWorkspace();
  const conv = id(); const call = id();
  try {
    await pool.query("INSERT INTO conversations(id, type, name, created_by) VALUES ($1,'group','g',$2)", [conv, a.u]);
    await pool.query("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')", [conv, a.u, b.u]);
    await pool.query("INSERT INTO calls(id, conversation_id, started_by, kind, status, answered_at) VALUES ($1,$2,$3,'audio','active',NOW())", [call, conv, a.u]);
    await pool.query("INSERT INTO call_participants(call_id,user_id,status) VALUES ($1,$2,'joined'),($1,$3,'joined')", [call, a.u, b.u]);

    await pool.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conv, b.u]); // removed from the group
    await assert.rejects(calls.issueToken(call, b.u), (e) => e.status === 404);
    await assert.rejects(calls.joinCall(call, b.u), (e) => e.status === 404);

    await calls.dropUserFromLiveCalls(conv, b.u);
    const { rows } = await pool.query('SELECT status FROM call_participants WHERE call_id=$1 AND user_id=$2', [call, b.u]);
    assert.equal(rows[0].status, 'left');
  } finally {
    await pool.query('DELETE FROM conversations WHERE id = $1', [conv]);
    await a.cleanup(); await b.cleanup();
  }
});
