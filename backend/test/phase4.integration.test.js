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
