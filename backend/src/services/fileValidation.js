const path = require('path');
const crypto = require('crypto');
const { httpError } = require('../utils/http');

/**
 * fileValidation.js
 * ─────────────────
 * Synchronous, content-level checks on an uploaded document before anything is
 * written to storage. The extension allow-list lives in middleware/upload.js;
 * this adds what the extension can't prove: the file is non-empty and its
 * leading bytes match the format it claims to be.
 */

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// Binary formats: magic bytes. PDF readers tolerate junk before the header, so
// "%PDF-" may appear anywhere in the first KB; the rest must start with it.
const BINARY_FORMATS = {
  '.pdf':  { label: 'PDF',        matches: (b) => b.subarray(0, 1024).includes('%PDF-') },
  '.docx': { label: 'Word',       matches: (b) => b.subarray(0, 4).equals(ZIP) },
  '.pptx': { label: 'PowerPoint', matches: (b) => b.subarray(0, 4).equals(ZIP) },
  '.xlsx': { label: 'Excel',      matches: (b) => b.subarray(0, 4).equals(ZIP) },
  '.xls':  { label: 'Excel',      matches: (b) => b.subarray(0, 8).equals(OLE) },
};

// Text formats must be text: a NUL byte in the head means a binary file with a
// renamed extension (an exe called notes.txt, for instance).
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.html', '.htm', '.json']);

const MAX_NAME_LENGTH = 200; // sources.name is VARCHAR(255)

/** Strip any directory part and control characters from a client-supplied name. */
const sanitizeFilename = (originalName) => {
  const base = path.basename(String(originalName || '').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'document';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const ext = path.extname(cleaned);
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
};

/**
 * @param {{originalname: string, buffer: Buffer}} file  multer memory file
 * @returns {{name: string, extension: string, size: number, sha256: string}}
 * @throws  error with .status 400 and a user-safe message
 */
const validateUploadedFile = (file) => {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw httpError(400, 'No file uploaded under the "file" field.');
  }
  const name = sanitizeFilename(file.originalname);
  const extension = path.extname(name).toLowerCase();

  if (file.buffer.length === 0) {
    throw httpError(400, 'This file is empty.');
  }

  const binary = BINARY_FORMATS[extension];
  if (binary && !binary.matches(file.buffer)) {
    throw httpError(400, `This doesn't look like a valid ${binary.label} file (${extension}).`);
  }
  if (TEXT_EXTENSIONS.has(extension) && file.buffer.subarray(0, 8192).includes(0)) {
    throw httpError(400, `This doesn't look like a text file (${extension}).`);
  }
  if (!binary && !TEXT_EXTENSIONS.has(extension)) {
    throw httpError(400, 'Unsupported file type.');
  }

  return {
    name,
    extension,
    size: file.buffer.length,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
  };
};

module.exports = { validateUploadedFile, sanitizeFilename };
