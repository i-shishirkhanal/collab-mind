const aiClient = require('./aiClient');
const pool = require('../db/postgres');
const { v4: uuidv4 } = require('uuid');

// The AI service gives up on a document after EXTRACTION_TIMEOUT_SECONDS (180s
// by default) and always writes a terminal status. A source still "processing"
// well past that means the AI service died mid-job, so it may be retried.
const STALE_PROCESSING_MINUTES = () => Number(process.env.SOURCE_STALE_MINUTES) || 10;

const SOURCE_COLUMNS = `id, workspace_id, name, type, url, status, metadata,
                        created_by, created_at, updated_at`;

/**
 * getWorkspaceSources
 * Lists a workspace's sources, newest first. Never exposes other workspaces.
 */
const getWorkspaceSources = async (workspaceId, { type } = {}) => {
  let query = `SELECT ${SOURCE_COLUMNS} FROM sources WHERE workspace_id = $1`;
  const params = [workspaceId];

  if (type) {
    query += ` AND type = $${params.length + 1}`;
    params.push(type);
  }

  query += ' ORDER BY created_at DESC';

  const { rows } = await pool.query(query, params);
  return rows;
};

/** One source, always scoped by workspace so an id from another workspace is a miss. */
const getSource = async (workspaceId, sourceId) => {
  const { rows } = await pool.query(
    `SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = $1 AND workspace_id = $2`,
    [sourceId, workspaceId]
  );
  return rows[0] || null;
};

/** Existing source in this workspace with identical file content, if any. */
const findDuplicateByHash = async (workspaceId, sha256) => {
  const { rows } = await pool.query(
    `SELECT id, name, status FROM sources
      WHERE workspace_id = $1 AND metadata->>'sha256' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, sha256]
  );
  return rows[0] || null;
};

/**
 * createSourceRecord
 * Inserts a new row into the sources table (status 'processing', stage
 * 'queued'). Used for files and URLs.
 */
const createSourceRecord = async (workspaceId, userId, { name, type, url = null, metadata = {} }) => {
  const id = uuidv4();
  const meta = { stage: 'queued', attempts: 0, ...metadata };

  const { rows } = await pool.query(
    `INSERT INTO sources (id, workspace_id, name, type, url, metadata, status, created_by, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7, NOW(), NOW())
       RETURNING *`,
    [id, workspaceId, name, type, url, JSON.stringify(meta), userId]
  );

  return rows[0];
};

/**
 * Marks a source failed with a user-safe message. Only touches a source that is
 * still 'processing', so a late failure report can't overwrite a 'ready' result.
 */
const markSourceFailed = async (workspaceId, sourceId, message) => {
  await pool.query(
    `UPDATE sources
        SET status = 'failed',
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND status = 'processing'`,
    [sourceId, workspaceId, JSON.stringify({ error: message, stage: 'failed' })]
  );
};

/**
 * triggerAiEmbedding
 * Asks the Python AI service to extract, chunk, embed and store a source. The
 * AI service owns the final status. If it can't even be reached the source is
 * marked failed here, so it never sits in 'processing' forever.
 */
const triggerAiEmbedding = async (workspaceId, sourceId, storageUrl) => {
  try {
    await aiClient.post('/embed', {
      workspace_id: workspaceId,
      source_id: sourceId,
      storage_url: storageUrl
    }, { timeout: 300_000 });
  } catch (err) {
    // Any other HTTP response means the AI service ran and recorded its own
    // outcome. Auth rejections (401/403) and 503 mean it never started the job.
    if (err.response && ![401, 403, 503].includes(err.response.status)) return;
    console.error(`[AI Trigger Error] /embed for source ${sourceId}: ${err.message}`);
    await markSourceFailed(
      workspaceId,
      sourceId,
      'The processing service is unavailable right now. Please retry in a moment.'
    ).catch(console.error);
  }
};

/**
 * beginRetry
 * Atomically moves a failed (or stale 'processing') source back to
 * 'processing'. Returns the updated row, or null if the source isn't
 * retryable — so two concurrent retry clicks start only one job.
 */
const beginRetry = async (workspaceId, sourceId) => {
  const { rows } = await pool.query(
    `UPDATE sources
        SET status = 'processing',
            metadata = (COALESCE(metadata, '{}'::jsonb) - 'error')
                       || jsonb_build_object(
                            'stage', 'queued',
                            'attempts', COALESCE((metadata->>'attempts')::int, 0) + 1),
            updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
        AND (status = 'failed'
             OR (status = 'processing'
                 AND updated_at < NOW() - make_interval(mins => $3)))
      RETURNING *`,
    [sourceId, workspaceId, STALE_PROCESSING_MINUTES()]
  );
  return rows[0] || null;
};

/** Deletes the source row; source_chunks go with it via ON DELETE CASCADE. */
const deleteSource = async (workspaceId, sourceId) => {
  const { rows } = await pool.query(
    'DELETE FROM sources WHERE id = $1 AND workspace_id = $2 RETURNING id, url, type',
    [sourceId, workspaceId]
  );
  return rows[0] || null;
};

module.exports = {
  getWorkspaceSources,
  getSource,
  findDuplicateByHash,
  createSourceRecord,
  markSourceFailed,
  triggerAiEmbedding,
  beginRetry,
  deleteSource,
};
