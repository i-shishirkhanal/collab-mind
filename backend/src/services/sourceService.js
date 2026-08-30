const axios = require('axios');
const pool = require('../db/postgres');
const { v4: uuidv4 } = require('uuid');

const AI_SERVICE_URL = () => process.env.AI_SERVICE_URL || 'http://localhost:8000';

/**
 * getWorkspaceSources
 * ────────────────────
 * Retrieves all knowledge sources (documents, URLs, etc.) associated with a
 * workspace, ordered by most recently added first.
 */
const getWorkspaceSources = async (workspaceId, { type } = {}) => {
  let query = `
    SELECT id, workspace_id, name, type, url,
           status, metadata, created_by, created_at, updated_at
      FROM sources
     WHERE workspace_id = $1
  `;
  const params = [workspaceId];

  if (type) {
    query += ` AND type = $${params.length + 1}`;
    params.push(type);
  }

  query += ' ORDER BY created_at DESC';

  const { rows } = await pool.query(query, params);
  return rows;
};

/**
 * createSourceRecord
 * ───────────────────
 * Inserts a new row into the sources table. Used for files, raw text, and URLs.
 */
const createSourceRecord = async (workspaceId, userId, { name, type, url = null, metadata = {} }) => {
  const id = uuidv4();
  
  const { rows } = await pool.query(
    `INSERT INTO sources (id, workspace_id, name, type, url, metadata, status, created_by, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7, NOW(), NOW())
       RETURNING *`,
    [id, workspaceId, name, type, url, metadata, userId]
  );
  
  return rows[0];
};

/**
 * triggerAiEmbedding
 * ──────────────────
 * Triggers the Python AI Backend to process and embed a document or URL asynchronously.
 */
const triggerAiEmbedding = async (workspaceId, sourceId, storageUrl) => {
  axios.post(`${AI_SERVICE_URL()}/embed`, {
    workspace_id: workspaceId,
    source_id: sourceId,
    storage_url: storageUrl
  }, { timeout: 300_000 }).catch(err => {
    console.error(`[AI Trigger Error] Failed to trigger /embed: ${err.message}`);
  });
};

module.exports = { getWorkspaceSources, createSourceRecord, triggerAiEmbedding };
