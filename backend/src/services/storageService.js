const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

/**
 * storageService.js
 * ─────────────────
 * Handles uploads to Google Cloud Storage bucket with automatic local disk fallback.
 */

// Initialize GCS storage client
const storage = new Storage();
const bucketName = process.env.GCS_BUCKET_NAME;

const uploadsDir = () => path.resolve(process.env.UPLOADS_DIR || '/app/uploads');

/**
 * Uploads a raw memory buffer to GCS or local disk.
 *
 * @param {string} workspaceId  - To organize files by workspace (must be a validated UUID)
 * @param {Buffer} fileBuffer   - Multer memory buffer
 * @param {string} originalName - The client's original filename
 * @param {string} mimeType     - Application MIME type
 * @returns {Promise<string>}   - Storage URI (gs://... or local://...)
 */
const uploadFileBuffer = async (workspaceId, fileBuffer, originalName, mimeType) => {
  const uniqueId = uuidv4();
  const safeFilename = path.basename(originalName).replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const relativePath = `workspaces/${workspaceId}/sources/${uniqueId}/${safeFilename}`;

  // 1. Attempt GCS upload if a valid non-default bucket is provided
  if (bucketName && bucketName !== 'collabmind-uploads') {
    try {
      const bucket = storage.bucket(bucketName);
      const file = bucket.file(relativePath);

      await new Promise((resolve, reject) => {
        const blobStream = file.createWriteStream({
          resumable: false,
          contentType: mimeType,
        });
        blobStream.on('error', reject);
        blobStream.on('finish', resolve);
        blobStream.end(fileBuffer);
      });

      return `gs://${bucketName}/${relativePath}`;
    } catch (err) {
      console.warn(`[Storage] GCS upload failed (${err.message}). Using local disk fallback.`);
    }
  }

  // 2. Local disk fallback for dev/testing environments
  const root = uploadsDir();
  const fullPath = path.resolve(root, relativePath);
  if (!fullPath.startsWith(root + path.sep)) {
    throw new Error('Refusing to write outside the uploads directory');
  }

  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, fileBuffer);

  return `local://${fullPath}`;
};

/**
 * Best-effort removal of a stored file (and its per-upload folder for local
 * storage). Never throws: a leftover file must not block deleting the record.
 * Local paths are only deleted if they resolve inside the uploads directory.
 */
const deleteStoredFile = async (storageUrl) => {
  try {
    if (!storageUrl) return;
    if (storageUrl.startsWith('gs://')) {
      const [bucket, ...rest] = storageUrl.slice(5).split('/');
      await storage.bucket(bucket).file(rest.join('/')).delete({ ignoreNotFound: true });
    } else if (storageUrl.startsWith('local://')) {
      const root = uploadsDir();
      const target = path.resolve(storageUrl.slice('local://'.length));
      const folder = path.dirname(target);
      // Only ever remove a per-upload folder, never the uploads root itself.
      if (!folder.startsWith(root + path.sep)) return;
      await fs.promises.rm(folder, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[Storage] Could not delete ${storageUrl}: ${err.message}`);
  }
};

module.exports = {
  uploadFileBuffer,
  deleteStoredFile,
};
