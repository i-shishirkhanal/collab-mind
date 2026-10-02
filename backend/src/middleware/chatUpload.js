const multer = require('multer');
const { MAX_FILE_BYTES } = require('../services/messageService');
const { httpError } = require('../utils/http');

// Memory storage: the buffer is streamed straight to Supabase Storage, nothing touches local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

/** Single-file upload under field name "file" with friendly size errors. */
const chatUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(httpError(413, 'File is too large (max 25 MB)'));
    return next(httpError(400, err.message || 'Upload failed'));
  });
};

module.exports = chatUpload;
