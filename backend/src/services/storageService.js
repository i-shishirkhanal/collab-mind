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

/**
 * Uploads a raw memory buffer to GCS or local disk.
 *
 * @param {string} workspaceId  - To organize files by workspace
 * @param {Buffer} fileBuffer   - Multer memory buffer
 * @param {string} originalName - The client's original filename
 * @param {string} mimeType     - Application MIME type
 * @returns {Promise<string>}   - Storage URI (gs://... or local://...)
 */
const uploadFileBuffer = async (workspaceId, fileBuffer, originalName, mimeType) => {
  const uniqueId = uuidv4();
  const safeFilename = originalName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
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
  const uploadsDir = process.env.UPLOADS_DIR || '/app/uploads';
  const fullPath = path.join(uploadsDir, relativePath);

  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, fileBuffer);

  return `local://${fullPath}`;
};

module.exports = {
  uploadFileBuffer,
};
