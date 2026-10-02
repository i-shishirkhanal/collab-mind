const { v4: uuidv4 } = require('uuid');
const { httpError } = require('../utils/http');

/**
 * Supabase Storage client for chat attachments, using the Storage REST API
 * directly (no extra dependency). Uses the service-role key, which must only
 * exist in backend env. The bucket is private; clients only ever receive
 * short-lived signed URLs after a membership check.
 */
const BUCKET = 'chat-files';
const SIGNED_URL_TTL_SECONDS = 300;

const cfg = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
});

const isConfigured = () => {
  const { url, key } = cfg();
  return Boolean(url && key);
};

const safeName = (name) => name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120) || 'file';

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** @returns {Promise<string>} object path inside the bucket */
const upload = async (conversationId, buffer, originalName, mimeType) => {
  if (!isConfigured()) throw httpError(503, 'File storage is not configured on this server');
  const { url, key } = cfg();
  const objectPath = `${conversationId}/${uuidv4()}/${safeName(originalName)}`;

  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodePath(objectPath)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!res.ok) {
    console.error(`[ChatStorage] upload failed: ${res.status} ${await res.text().catch(() => '')}`);
    throw httpError(502, 'Failed to store file');
  }
  return objectPath;
};

/** @returns {Promise<string>} absolute signed download URL */
const createSignedUrl = async (objectPath, downloadName) => {
  if (!isConfigured()) throw httpError(503, 'File storage is not configured on this server');
  const { url, key } = cfg();
  const res = await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${encodePath(objectPath)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
  });
  if (!res.ok) throw httpError(502, 'Failed to create download link');
  const { signedURL } = await res.json();
  const full = `${url}/storage/v1${signedURL}`;
  return downloadName ? `${full}&download=${encodeURIComponent(downloadName)}` : full;
};

module.exports = { isConfigured, upload, createSignedUrl, BUCKET };
