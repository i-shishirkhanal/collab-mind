const multer = require('multer');

// Configure multer to use fully in-memory storage (no direct write to local disk)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  // Only accept PDF, DOCX, and TXT files based on MIME type
  const allowedMimeTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    // Accept the file
    cb(null, true);
  } else {
    // Reject the file with a custom error message
    const error = new Error('Invalid file type. Only PDF, DOCX, and TXT files are allowed.');
    error.status = 400;
    cb(error, false);
  }
};

/**
 * Upload middleware instance.
 * - Stores files in memory as Node Buffers.
 * - Enforces a 50MB file size limit.
 * - Enforces allowed file types via fileFilter.
 */
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB max
  },
  fileFilter,
});

module.exports = upload;
