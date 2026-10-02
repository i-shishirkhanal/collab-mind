const path = require('path');
const multer = require('multer');

// Configure multer to use fully in-memory storage (no direct write to local disk)
const storage = multer.memoryStorage();

// Formats the AI service can extract text from (MarkItDown). Validated by file
// extension because browsers report inconsistent MIME types for several of
// these (.md, .csv, .xls) and the MIME type is client-supplied anyway; the
// upload controller then checks the file's real signature (fileValidation.js)
// and the AI service checks it again before parsing.
const ALLOWED_EXTENSIONS = [
  '.pdf', '.docx', '.pptx', '.xlsx', '.xls',
  '.txt', '.md', '.csv', '.html', '.htm', '.json',
];

const MAX_FILE_BYTES = 50 * 1024 * 1024;

const fileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname || '').toLowerCase();

  if (ALLOWED_EXTENSIONS.includes(extension)) {
    cb(null, true);
  } else {
    const error = new Error(
      `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.`
    );
    error.status = 400;
    cb(error, false);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 1,
  },
  fileFilter,
});

/** Upload.single('file') with multer's own errors mapped to proper HTTP statuses. */
const uploadSingle = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        err.status = 413;
        err.message = `File is too large (limit ${MAX_FILE_BYTES / 1024 / 1024} MB).`;
      } else {
        err.status = 400;
        err.message = 'Upload one file at a time, in the "file" field.';
      }
    }
    next(err);
  });
};

module.exports = { uploadSingle, ALLOWED_EXTENSIONS, MAX_FILE_BYTES };
