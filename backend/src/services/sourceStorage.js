const { httpError } = require('../utils/http');

/**
 * Supabase Storage for workspace source documents (Storage REST API, service-role
 * key, backend env only). The bucket is private and is created on first use. Files
 * are addressed as `supabase://sources/<object path>`; the AI service downloads them
 * with its own copy of the same credentials.
 */
const BUCKET = 'sources';
const SCHEME = `supabase://${BUCKET}/`;

const cfg = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
});

const isConfigured = () => {
  const { url, key } = cfg();
  return Boolean(url && key);
};

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const authHeaders = (key) => ({ Authorization: `Bearer ${key}`, apikey: key });

const ensureBucket = async () => {
  const { url, key } = cfg();
  const res = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  // 409 / "already exists" means a concurrent request or earlier run created it.
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '');
    if (!/already exists/i.test(text)) throw new Error(`bucket create failed: ${res.status} ${text}`);
  }
};

const post = (objectPath, buffer, mimeType) => {
  const { url, key } = cfg();
  return fetch(`${url}/storage/v1/object/${BUCKET}/${encodePath(objectPath)}`, {
    method: 'POST',
    headers: {
      ...authHeaders(key),
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: buffer,
  });
};

/** @returns {Promise<string>} supabase://sources/<objectPath> */
const upload = async (objectPath, buffer, mimeType) => {
  let res = await post(objectPath, buffer, mimeType);
  if (res.status === 404) { // bucket missing: create it once, then retry
    try {
      await ensureBucket();
    } catch (err) {
      console.error(`[SourceStorage] ${err.message}`);
      throw httpError(502, 'File storage is unavailable right now. Please try again later.');
    }
    res = await post(objectPath, buffer, mimeType);
  }
  if (!res.ok) {
    console.error(`[SourceStorage] upload failed: ${res.status} ${await res.text().catch(() => '')}`);
    throw httpError(502, 'File storage is unavailable right now. Please try again later.');
  }
  return `${SCHEME}${objectPath}`;
};

/** Best-effort delete; callers treat failures as non-fatal. */
const remove = async (storageUrl) => {
  const { url, key } = cfg();
  if (!isConfigured()) return;
  const objectPath = storageUrl.slice(SCHEME.length);
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodePath(objectPath)}`, {
    method: 'DELETE',
    headers: authHeaders(key),
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[SourceStorage] Could not delete ${storageUrl}: ${res.status}`);
  }
};

module.exports = { SCHEME, isConfigured, upload, remove };
