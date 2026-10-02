const aiClient = require('../services/aiClient');
const { assertPublicHttpUrl } = require('../utils/urlSafety');
const sourceService = require('../services/sourceService');
const storageService = require('../services/storageService');
const { validateUploadedFile } = require('../services/fileValidation');
const { httpError } = require('../utils/http');

const BINARY_TYPES = ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'html', 'htm', 'md', 'json'];

/**
 * listSources — GET /workspaces/:workspaceId/sources
 */
const listSources = async (req, res, next) => {
  try {
    const { type } = req.query;
    const sources = await sourceService.getWorkspaceSources(req.params.workspaceId, { type });
    res.json(sources);
  } catch (err) {
    next(err);
  }
};

/**
 * getSource — GET /workspaces/:workspaceId/sources/:sourceId
 * Processing status, stage and error for one source.
 */
const getSource = async (req, res, next) => {
  try {
    const source = await sourceService.getSource(req.params.workspaceId, req.params.sourceId);
    if (!source) throw httpError(404, 'Source not found');
    res.json(source);
  } catch (err) {
    next(err);
  }
};

/**
 * uploadFile — POST /workspaces/:workspaceId/sources/upload
 */
const uploadFile = async (req, res, next) => {
  let gsUri = null;
  try {
    const { workspaceId } = req.params;

    // Content-level checks (non-empty, real magic bytes) before anything is stored.
    const checked = validateUploadedFile(req.file);

    const duplicate = await sourceService.findDuplicateByHash(workspaceId, checked.sha256);
    if (duplicate) {
      return res.status(409).json({
        error: `"${duplicate.name}" with identical content is already in this workspace.`,
        source_id: duplicate.id,
      });
    }

    // Source type comes from the extension; anything that isn't a known
    // document extension is stored as plain 'text'.
    const ext = checked.extension.slice(1);
    const type = BINARY_TYPES.includes(ext) ? (ext === 'htm' ? 'html' : ext) : 'text';

    gsUri = await storageService.uploadFileBuffer(
      workspaceId,
      req.file.buffer,
      checked.name,
      req.file.mimetype
    );

    const sourceRecord = await sourceService.createSourceRecord(workspaceId, req.user.id, {
      name: checked.name,
      type,
      url: gsUri,
      metadata: { sha256: checked.sha256, size_bytes: checked.size },
    });
    gsUri = null; // owned by the record now

    sourceService.triggerAiEmbedding(workspaceId, sourceRecord.id, sourceRecord.url).catch(console.error);

    res.status(202).json({
      source_id: sourceRecord.id,
      status: 'processing'
    });

  } catch (err) {
    // The file was stored but the record wasn't created: don't leave an orphan.
    if (gsUri) await storageService.deleteStoredFile(gsUri);
    next(err);
  }
};

/**
 * addUrlSource — POST /workspaces/:workspaceId/sources/url
 */
const addUrlSource = async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const { url } = req.body;

    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2048) {
      return res.status(400).json({ error: 'A valid http(s) URL is required' });
    }

    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
    const type = isYoutube ? 'youtube' : 'url';
    const name = url.slice(0, 255);

    const sourceRecord = await sourceService.createSourceRecord(workspaceId, req.user.id, {
      name,
      type,
      url
    });

    sourceService.triggerAiEmbedding(workspaceId, sourceRecord.id, url).catch(console.error);

    res.status(202).json({
      source_id: sourceRecord.id,
      status: 'processing'
    });
  } catch (err) {
    next(err);
  }
};

/**
 * retrySource — POST /workspaces/:workspaceId/sources/:sourceId/retry
 * Re-runs processing for a failed (or stuck) source. Idempotent: the AI
 * service replaces the source's chunks, never appends to them.
 */
const retrySource = async (req, res, next) => {
  try {
    const { workspaceId, sourceId } = req.params;
    const existing = await sourceService.getSource(workspaceId, sourceId);
    if (!existing) throw httpError(404, 'Source not found');

    const claimed = await sourceService.beginRetry(workspaceId, sourceId);
    if (!claimed) {
      throw httpError(409, existing.status === 'ready'
        ? 'This source is already processed.'
        : 'This source is still being processed.');
    }

    sourceService.triggerAiEmbedding(workspaceId, sourceId, claimed.url).catch(console.error);

    res.status(202).json({ source_id: sourceId, status: 'processing' });
  } catch (err) {
    next(err);
  }
};

/**
 * deleteSource — DELETE /workspaces/:workspaceId/sources/:sourceId
 * Allowed for whoever added the source, and for workspace admins/owners.
 */
const deleteSource = async (req, res, next) => {
  try {
    const { workspaceId, sourceId } = req.params;
    const existing = await sourceService.getSource(workspaceId, sourceId);
    if (!existing) throw httpError(404, 'Source not found');

    const role = req.membership?.role;
    const isManager = role === 'admin' || role === 'owner';
    if (!isManager && existing.created_by !== req.user.id) {
      throw httpError(403, 'Only the person who added this source, or a workspace admin, can delete it.');
    }

    const removed = await sourceService.deleteSource(workspaceId, sourceId);
    if (removed && removed.type !== 'url' && removed.type !== 'youtube') {
      await storageService.deleteStoredFile(removed.url);
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

/**
 * summarizeSource — POST /workspaces/:workspaceId/sources/:sourceId/summarize
 */
const summarizeSource = async (req, res, next) => {
  try {
    const { workspaceId, sourceId } = req.params;
    // The source must belong to THIS workspace before the AI service is asked about it.
    const existing = await sourceService.getSource(workspaceId, sourceId);
    if (!existing) throw httpError(404, 'Source not found');

    const response = await aiClient.post('/sources/summarize', {
      workspace_id: workspaceId,
      source_id: sourceId
    });
    res.json(response.data);
  } catch (err) {
    if (err.respon