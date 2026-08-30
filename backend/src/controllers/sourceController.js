const axios = require('axios');
const sourceService = require('../services/sourceService');
const storageService = require('../services/storageService');

const AI_SERVICE_URL = () => process.env.AI_SERVICE_URL || 'http://localhost:8000';

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
 * uploadFile — POST /workspaces/:workspaceId/sources/upload
 */
const uploadFile = async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded under "file" field' });
    }

    let type = 'text';
    if (file.mimetype === 'application/pdf') type = 'pdf';
    else if (file.mimetype.includes('wordprocessingml.document')) type = 'docx';

    const gsUri = await storageService.uploadFileBuffer(
      workspaceId,
      file.buffer,
      file.originalname,
      file.mimetype
    );

    const sourceRecord = await sourceService.createSourceRecord(workspaceId, req.user.id, {
      name: file.originalname,
      type,
      url: gsUri
    });

    sourceService.triggerAiEmbedding(workspaceId, sourceRecord.id, gsUri).catch(console.error);

    res.status(202).json({
      source_id: sourceRecord.id,
      status: 'processing'
    });

  } catch (err) {
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

    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(400).json({ error: 'A valid http(s) URL is required' });
    }

    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
    const type = isYoutube ? 'youtube' : 'url';
    const name = url;

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
 * summarizeSource — POST /workspaces/:workspaceId/sources/:sourceId/summarize
 */
const summarizeSource = async (req, res, next) => {
  try {
    const { workspaceId, sourceId } = req.params;
    const response = await axios.post(`${AI_SERVICE_URL()}/sources/summarize`, {
      workspace_id: workspaceId,
      source_id: sourceId
    });
    res.json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    next(err);
  }
};

module.exports = { listSources, uploadFile, addUrlSource, summarizeSource };
