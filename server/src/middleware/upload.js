/**
 * Multipart uploads — the counterpart of PHP's $_FILES.
 *
 * Files are held in memory (bounded by MAX_UPLOAD_MB) so each route can run
 * the same size, MIME and extension checks the PHP edition ran before it
 * decides where, and whether, the bytes are written to disk.
 *
 *   router.post('/', uploadSingle('file'), ah(async (req, res) => { req.file ... }))
 *
 * `req.file` is { originalname, mimetype, size, buffer } or undefined.
 */

import multer from 'multer';
import config from '../config/index.js';

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1 },
});

export const uploadSingle = (field = 'file') => memory.single(field);
